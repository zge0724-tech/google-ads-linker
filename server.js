const puppeteer = require('puppeteer'); 
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new DatabaseSync(path.join(__dirname, 'data.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alliance_name TEXT NOT NULL,
    original_link TEXT NOT NULL,
    proxy_url TEXT NOT NULL,
    expected_domain TEXT NOT NULL,
    mcc_id TEXT DEFAULT '',
    ads_account_id TEXT DEFAULT '',
    campaign_name TEXT NOT NULL UNIQUE,
    run_frequency INTEGER NOT NULL DEFAULT 60,
    run_hours TEXT NOT NULL DEFAULT '[]',
    referer TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    final_url TEXT DEFAULT '',
    last_run_at TEXT,
    last_updated TEXT,
    last_error TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

const runningTasks = new Set();

// 1. 补全缺失的数据库行转换函数
function rowToTask(row) {
    if (!row) return null;
    return {
        ...row,
        run_hours: parseRunHours(row.run_hours)
    };
}

// 2. 修复解析运行时间的函数结构
function parseRunHours(raw) {
    if (Array.isArray(raw)) return raw.map(Number);
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(Number) : [];
    } catch {
        return [];
    }
}

// 3. 独立且修复好的重定向与代理解析函数（增强了对 JS 重定向的等待与捕捉）
async function resolveFinalUrl(originalLink, proxyUrl, referer) {
    let browser = null;
    try {
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
        ];

        let proxyAuth = null;
        if (proxyUrl && proxyUrl.trim()) {
            try {
                let cleanProxy = proxyUrl.trim();
                let host, port, username, password;

                // 格式 1: ip:port:username:password
                if (!cleanProxy.includes('://') && cleanProxy.split(':').length === 4) {
                    const parts = cleanProxy.split(':');
                    host = parts[0];
                    port = parts[1];
                    username = parts[2];
                    password = parts[3];
                    args.push(`--proxy-server=http://${host}:${port}`);
                    proxyAuth = { username, password };
                } 
                // 格式 2: ip:port
                else if (!cleanProxy.includes('://') && cleanProxy.split(':').length === 2) {
                    args.push(`--proxy-server=http://${cleanProxy}`);
                } 
                // 格式 3: http://user:pass@ip:port 或标准 URL 格式
                else {
                    if (!cleanProxy.startsWith('http://') && !cleanProxy.startsWith('https://')) {
                        cleanProxy = 'http://' + cleanProxy;
                    }
                    const parsedProxy = new URL(cleanProxy);
                    args.push(`--proxy-server=http://${parsedProxy.hostname}:${parsedProxy.port}`);
                    if (parsedProxy.username || parsedProxy.password) {
                        proxyAuth = {
                            username: decodeURIComponent(parsedProxy.username),
                            password: decodeURIComponent(parsedProxy.password)
                        };
                    }
                }
            } catch (e) {
                console.error("代理 URL 解析失败:", e.message);
            }
        }

        browser = await puppeteer.launch({
            headless: true,
            args: args
        });

        const page = await browser.newPage();

        if (proxyAuth) {
            await page.authenticate(proxyAuth);
        }

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        
        if (referer) {
            await page.setExtraHTTPHeaders({ 'Referer': referer });
        }

        // 修改：等待网络连接彻底空闲 (networkidle2)，避免中间追踪页刚加载就退出
        await page.goto(originalLink, {
            waitUntil: 'networkidle2',
            timeout: 45000
        });

        // 强制等待 5 秒，确保页面内部 JS 异步跳转/追踪脚本执行完成
        await new Promise(resolve => setTimeout(resolve, 5000));

        const finalUrl = page.url();
        await browser.close();
        return finalUrl;

    } catch (error) {
        if (browser) await browser.close();
        throw new Error(`Puppeteer 解析失败: ${error.message}`);
    }
}

async function processTask(task) {
  if (runningTasks.has(task.id)) return;
  runningTasks.add(task.id);

  try {
    const finalUrl = await resolveFinalUrl(
      task.original_link,
      task.proxy_url,
      task.referer
    );

    const expected = task.expected_domain.toLowerCase().trim();
    const finalLower = (finalUrl || '').toLowerCase();

    if (!finalLower.includes(expected)) {
      const errMsg = `域名校验失败: Final URL "${finalUrl}" 不包含预期域名 "${task.expected_domain}"`;
      db.prepare(
        `UPDATE tasks SET last_error = ?, last_run_at = datetime('now') WHERE id = ?`
      ).run(errMsg, task.id);
      console.error(`[Task ${task.id}] ${errMsg}`);
      return;
    }

    db.prepare(
      `UPDATE tasks SET final_url = ?, last_error = '', last_updated = datetime('now'), last_run_at = datetime('now') WHERE id = ?`
    ).run(finalUrl, task.id);
    console.log(`[Task ${task.id}] Final URL updated: ${finalUrl}`);
  } catch (err) {
    const errMsg = err.message || String(err);
    db.prepare(
      `UPDATE tasks SET last_error = ?, last_run_at = datetime('now') WHERE id = ?`
    ).run(errMsg, task.id);
    console.error(`[Task ${task.id}] Error: ${errMsg}`);
  } finally {
    runningTasks.delete(task.id);
  }
}

function shouldRunTask(task, now) {
  const hours = parseRunHours(task.run_hours);
  if (hours.length > 0 && !hours.includes(now.getHours())) {
    return false;
  }

  if (!task.last_run_at) return true;

  const lastRun = new Date(task.last_run_at.replace(' ', 'T') + 'Z');
  const elapsedMs = now.getTime() - lastRun.getTime();
  const frequencyMs = (task.run_frequency || 60) * 60 * 1000;
  return elapsedMs >= frequencyMs;
}

cron.schedule('* * * * *', () => {
  const now = new Date();
  const tasks = db.prepare('SELECT * FROM tasks').all().map(rowToTask);

  for (const task of tasks) {
    if (shouldRunTask(task, now)) {
      processTask(task);
    }
  }
});

app.get('/api/info', (_req, res) => {
  res.json({
    baseUrl: BASE_URL,
    templateUrl: `${BASE_URL}/ashx/gettemplate.ashx`,
  });
});

app.get('/api/tasks', (_req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY id DESC').all().map(rowToTask);
  res.json(tasks);
});

app.get('/api/tasks/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '任务不存在' });
  res.json(rowToTask(row));
});

app.post('/api/tasks', (req, res) => {
  const {
    alliance_name,
    original_link,
    proxy_url,
    expected_domain,
    mcc_id = '',
    ads_account_id = '',
    campaign_name,
    run_frequency = 60,
    run_hours = [],
    referer = '',
    notes = '',
  } = req.body;

  if (!alliance_name || !original_link || !proxy_url || !expected_domain || !campaign_name) {
    return res.status(400).json({ error: '请填写所有必填字段' });
  }

  try {
    const result = db
      .prepare(
        `INSERT INTO tasks (alliance_name, original_link, proxy_url, expected_domain, mcc_id, ads_account_id, campaign_name, run_frequency, run_hours, referer, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        alliance_name,
        original_link,
        proxy_url,
        expected_domain,
        mcc_id,
        ads_account_id,
        campaign_name,
        run_frequency,
        JSON.stringify(run_hours),
        referer,
        notes
      );

    const task = rowToTask(
      db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid)
    );
    res.status(201).json(task);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: '广告系列名称已存在' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tasks/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '任务不存在' });

  const {
    alliance_name,
    original_link,
    proxy_url,
    expected_domain,
    mcc_id = '',
    ads_account_id = '',
    campaign_name,
    run_frequency = 60,
    run_hours = [],
    referer = '',
    notes = '',
  } = req.body;

  try {
    db.prepare(
      `UPDATE tasks SET
        alliance_name = ?, original_link = ?, proxy_url = ?, expected_domain = ?,
        mcc_id = ?, ads_account_id = ?, campaign_name = ?, run_frequency = ?,
        run_hours = ?, referer = ?, notes = ?
       WHERE id = ?`
    ).run(
      alliance_name,
      original_link,
      proxy_url,
      expected_domain,
      mcc_id,
      ads_account_id,
      campaign_name,
      run_frequency,
      JSON.stringify(run_hours),
      referer,
      notes,
      req.params.id
    );

    res.json(rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id)));
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: '广告系列名称已存在' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tasks/:id', (req, res) => {
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: '任务不存在' });
  res.json({ success: true });
});

app.post('/api/tasks/:id/run', async (req, res) => {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '任务不存在' });

  const task = rowToTask(row);
  await processTask(task);
  const updated = rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id));
  res.json(updated);
});

app.get('/ashx/gettemplate.ashx', (req, res) => {
  const { campaign_name } = req.query;
  if (!campaign_name) {
    res.type('text/plain').send('');
    return;
  }

  const row = db
    .prepare(
      `SELECT final_url FROM tasks WHERE campaign_name = ? AND final_url != '' ORDER BY last_updated DESC LIMIT 1`
    )
    .get(campaign_name);

  res.type('text/plain').send(row?.final_url || '');
});

app.get('/api/ads-script', (req, res) => {
  const script = generateAdsScript(BASE_URL);
  res.type('text/plain').send(script);
});

function generateAdsScript(baseUrl) {
  return `/**
 * Google Ads 自动换链脚本
 * 将此脚本添加到 Google Ads -> 工具与设置 -> 批量操作 -> 脚本
 * 建议设置每日定时运行
 */
function main() {
  var campaignName = AdsApp.currentAccount().getName(); // 或手动指定广告系列名称
  var apiUrl = '${baseUrl}/ashx/gettemplate.ashx?campaign_name=' + encodeURIComponent(campaignName);

  var response = UrlFetchApp.fetch(apiUrl, { muteHttpExceptions: true });
  var finalUrl = response.getContentText().trim();

  if (!finalUrl) {
    Logger.log('未获取到 Final URL，跳过更新');
    return;
  }

  Logger.log('获取到 Final URL: ' + finalUrl);

  var campaignIterator = AdsApp.campaigns()
    .withCondition('Name = "' + campaignName + '"')
    .get();

  if (!campaignIterator.hasNext()) {
    Logger.log('未找到广告系列: ' + campaignName);
    return;
  }

  var campaign = campaignIterator.next();
  var adGroupIterator = campaign.adGroups().get();

  while (adGroupIterator.hasNext()) {
    var adGroup = adGroupIterator.next();
    var adIterator = adGroup.ads().get();

    while (adIterator.hasNext()) {
      var ad = adIterator.next();
      if (ad.isType().responsiveSearchAd()) {
        // 响应式搜索广告需通过 adGroup 更新 Final URL
        continue;
      }
      try {
        var urls = ad.urls();
        if (urls.getFinalUrl() !== finalUrl) {
          urls.setFinalUrl(finalUrl);
          Logger.log('已更新广告 Final URL -> ' + finalUrl);
        }
      } catch (e) {
        Logger.log('更新广告失败: ' + e.message);
      }
    }
  }

  Logger.log('换链完成');
}
`;
}

app.listen(PORT, () => {
  console.log(`Google Ads Linker running at ${BASE_URL}`);
  console.log(`Admin panel: ${BASE_URL}/linklist.html`);
});

module.exports = { app, db, processTask };