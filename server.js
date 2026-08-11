const puppeteer = require('puppeteer'); 
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;
try {
    db = new DatabaseSync(path.join(__dirname, 'data.db'));
    
    // 初始化 tasks 数据表
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
        status TEXT DEFAULT 'active',
        is_deleted INTEGER DEFAULT 0,
        run_count INTEGER DEFAULT 0,
        last_run_at TEXT,
        last_updated TEXT,
        last_changed_at TEXT,
        last_error TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // 兼容旧版本数据库字段补全
    const addColumnSafely = (sql) => {
        try { db.exec(sql); } catch (e) {}
    };
    addColumnSafely(`ALTER TABLE tasks ADD COLUMN status TEXT DEFAULT 'active'`);
    addColumnSafely(`ALTER TABLE tasks ADD COLUMN is_deleted INTEGER DEFAULT 0`);
    addColumnSafely(`ALTER TABLE tasks ADD COLUMN run_count INTEGER DEFAULT 0`);
    addColumnSafely(`ALTER TABLE tasks ADD COLUMN last_changed_at TEXT`);

} catch (err) {
    console.error("数据库初始化失败，请确保 Node.js 版本在 v22.5.0 以上:", err.message);
}

const runningTasks = new Set();

function parseRunHours(raw) {
    if (Array.isArray(raw)) return raw.map(Number);
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(Number) : [];
    } catch {
        return [];
    }
}

function rowToTask(row) {
    if (!row) return null;
    return {
        ...row,
        run_hours: parseRunHours(row.run_hours),
        status: row.status || 'active',
        is_deleted: row.is_deleted || 0,
        run_count: row.run_count || 0
    };
}

async function resolveFinalUrl(originalLink, proxyUrl, referer, expectedDomain) {
    // --- 核心优化 1：自动补全联盟链接末尾的目标商家网址 ---
    let finalOriginalLink = originalLink.trim();
    if (expectedDomain && expectedDomain.trim()) {
        const cleanDomain = expectedDomain.trim();
        const targetUrl = cleanDomain.startsWith('http') ? cleanDomain : `https://${cleanDomain}`;
        
        // 匹配 url=, redirect=, dest= 等常见的中间跳转参数结尾
        if (/(url|redirect|dest|link)=$/i.test(finalOriginalLink)) {
            finalOriginalLink = finalOriginalLink + targetUrl;
            console.log(`[自动补全联盟链接] -> 拼接商家网址后: ${finalOriginalLink}`);
        }
    }

    const convertToLpurl = (fullUrl) => {
        if (!fullUrl) return '{lpurl}';
        try {
            const parsed = new URL(fullUrl);
            if (parsed.search) {
                return `{lpurl}${parsed.search}`;
            }
        } catch (e) {
            if (fullUrl.includes('?')) {
                return `{lpurl}${fullUrl.substring(fullUrl.indexOf('?'))}`;
            }
        }
        return '{lpurl}';
    };

    let cleanDomainKeyword = '';
    try {
        const domainUrl = new URL(expectedDomain.startsWith('http') ? expectedDomain : `https://${expectedDomain}`);
        cleanDomainKeyword = domainUrl.hostname.replace('www.', '').split('.')[0];
    } catch(e) {
        cleanDomainKeyword = expectedDomain;
    }

    let browser = null;
    try {
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ];

        let proxyAuth = null;
        if (proxyUrl && proxyUrl.trim()) {
            try {
                let cleanProxy = proxyUrl.trim();
                let host, port, username, password;

                if (!cleanProxy.includes('://') && cleanProxy.split(':').length === 4) {
                    const parts = cleanProxy.split(':');
                    host = parts[0]; port = parts[1]; username = parts[2]; password = parts[3];
                    args.push(`--proxy-server=http://${host}:${port}`);
                    proxyAuth = { username, password };
                } else if (!cleanProxy.includes('://') && cleanProxy.split(':').length === 2) {
                    args.push(`--proxy-server=http://${cleanProxy}`);
                } else {
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
            args: args,
            timeout: 60000
        });

        const page = await browser.newPage();

        if (proxyAuth) {
            await page.authenticate(proxyAuth);
        }

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        
        if (referer) {
            await page.setExtraHTTPHeaders({ 'Referer': referer });
        }

        let capturedUrls = [];

        page.on('response', response => {
            const status = response.status();
            if (status >= 300 && status < 400) {
                const location = response.headers()['location'];
                if (location && location.includes('?')) {
                    capturedUrls.push(location);
                }
            }
        });

        page.on('request', req => {
            const reqUrl = req.url();
            if (reqUrl.includes('?') && !reqUrl.match(/\.(png|jpg|jpeg|gif|svg|css|js|woff2?)$/i)) {
                capturedUrls.push(reqUrl);
            }
        });

        page.on('framenavigated', frame => {
            if (frame === page.mainFrame()) {
                capturedUrls.push(frame.url());
            }
        });

        // --- 使用自动补全后的 finalOriginalLink 进行导航 ---
        await page.goto(finalOriginalLink, {
            waitUntil: 'networkidle2',
            timeout: 45000
        }).catch(() => {});

        await new Promise(resolve => setTimeout(resolve, 5000));

        const finalPageUrl = page.url();
        capturedUrls.push(finalPageUrl);

        await browser.close();

        const isIntermediateUrl = (u) => {
            const lower = u.toLowerCase();
            return lower.includes('code=') || 
                   lower.includes('return=') || 
                   lower.includes('redirect=') || 
                   lower.includes('url=') || 
                   lower.includes('subid');
        };

        const matchedTrackedUrl = capturedUrls.reverse().find(u => {
            const hasDomain = cleanDomainKeyword ? u.includes(cleanDomainKeyword) : true;
            const hasTrackParams = u.includes('irclickid') || u.includes('irgwc') || u.includes('gclid') || u.includes('utm_');
            return hasDomain && hasTrackParams && !isIntermediateUrl(u);
        });

        if (matchedTrackedUrl) {
            console.log(`[精准匹配到目标域名追踪参数]: ${matchedTrackedUrl}`);
            return convertToLpurl(matchedTrackedUrl);
        }

        if (finalPageUrl.includes('?') && !isIntermediateUrl(finalPageUrl)) {
            return convertToLpurl(finalPageUrl);
        }

        const cleanTarget = capturedUrls.reverse().find(u => 
            (cleanDomainKeyword ? u.includes(cleanDomainKeyword) : true) && 
            u.includes('?') && 
            !isIntermediateUrl(u)
        );

        return convertToLpurl(cleanTarget || finalPageUrl);

    } catch (error) {
        if (browser) {
            try { await browser.close(); } catch(e) {}
        }
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
      task.referer,
      task.expected_domain
    );

    if (!finalUrl) {
      const errMsg = `抓取结果为空`;
      db.prepare(
        `UPDATE tasks SET last_error = ?, last_run_at = datetime('now'), run_count = run_count + 1 WHERE id = ?`
      ).run(errMsg, task.id);
      console.error(`[Task ${task.id}] ${errMsg}`);
      return;
    }

    const oldTask = db.prepare('SELECT final_url FROM tasks WHERE id = ?').get(task.id);
    const isUrlChanged = oldTask && oldTask.final_url !== finalUrl;

    if (isUrlChanged) {
        db.prepare(
          `UPDATE tasks SET final_url = ?, last_error = '', last_updated = datetime('now'), last_run_at = datetime('now'), last_changed_at = datetime('now'), run_count = run_count + 1 WHERE id = ?`
        ).run(finalUrl, task.id);
    } else {
        db.prepare(
          `UPDATE tasks SET final_url = ?, last_error = '', last_updated = datetime('now'), last_run_at = datetime('now'), run_count = run_count + 1 WHERE id = ?`
        ).run(finalUrl, task.id);
    }

    console.log(`[Task ${task.id}] Final URL updated: ${finalUrl}`);
  } catch (err) {
    const errMsg = err.message || String(err);
    db.prepare(
      `UPDATE tasks SET last_error = ?, last_run_at = datetime('now'), run_count = run_count + 1 WHERE id = ?`
    ).run(errMsg, task.id);
    console.error(`[Task ${task.id}] Error: ${errMsg}`);
  } finally {
    runningTasks.delete(task.id);
  }
}

function shouldRunTask(task, now) {
  if (task.status === 'paused' || task.is_deleted === 1) return false;

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
  if (!db) return;
  const tasks = db.prepare('SELECT * FROM tasks WHERE is_deleted = 0').all().map(rowToTask);

  for (const task of tasks) {
    if (shouldRunTask(task, now)) {
      processTask(task);
    }
  }
});

// --- API 接口定义 ---

app.get('/api/info', (_req, res) => {
  res.json({
    baseUrl: BASE_URL,
    templateUrl: `${BASE_URL}/ashx/gettemplate.ashx`,
  });
});

app.get('/api/stats', (_req, res) => {
    try {
        const total = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE is_deleted = 0').get().count;
        const active = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'active' AND is_deleted = 0").get().count;
        const paused = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'paused' AND is_deleted = 0").get().count;
        const deleted = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE is_deleted = 1').get().count;
        const totalRuns = db.prepare('SELECT SUM(run_count) as total FROM tasks').get().total || 0;

        res.json({ total, active, paused, deleted, totalRuns });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/alliances', (_req, res) => {
    try {
        const rows = db.prepare('SELECT DISTINCT alliance_name FROM tasks WHERE is_deleted = 0').all();
        const alliances = rows.map(r => r.alliance_name).filter(Boolean);
        res.json(alliances);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/tasks', (req, res) => {
  try {
    const { alliance, status, campaign_name } = req.query;
    let sql = 'SELECT * FROM tasks WHERE is_deleted = 0';
    const params = [];

    if (alliance && alliance !== '全部') {
        sql += ' AND alliance_name = ?';
        params.push(alliance);
    }
    if (status && status !== '全部') {
        sql += ' AND status = ?';
        params.push(status === '运行中' ? 'active' : 'paused');
    }
    if (campaign_name) {
        sql += ' AND campaign_name LIKE ?';
        params.push(`%${campaign_name}%`);
    }

    sql += ' ORDER BY id DESC';

    const tasks = db.prepare(sql).all(...params).map(rowToTask);
    res.json(tasks);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tasks/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: '任务不存在' });
    res.json(rowToTask(row));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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
        `INSERT INTO tasks (alliance_name, original_link, proxy_url, expected_domain, mcc_id, ads_account_id, campaign_name, run_frequency, run_hours, referer, notes, status, is_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0)`
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

    processTask(task);

    res.status(201).json(task);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: '广告系列名称已存在' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/tasks/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['active', 'paused'].includes(status)) {
    return res.status(400).json({ error: '无效的状态参数' });
  }

  try {
    const result = db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: '任务不存在' });

    const task = rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id));
    res.json(task);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
  try {
    const result = db.prepare('UPDATE tasks SET is_deleted = 1 WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: '任务不存在' });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tasks/:id/run', async (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: '任务不存在' });

    const task = rowToTask(row);
    await processTask(task);
    const updated = rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id));
    res.json(updated);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/ashx/gettemplate.ashx', (req, res) => {
  const { campaign_name } = req.query;
  if (!campaign_name) {
    res.type('text/plain').send('');
    return;
  }

  const row = db
    .prepare(
      `SELECT final_url FROM tasks WHERE campaign_name = ? AND final_url != '' AND is_deleted = 0 ORDER BY last_updated DESC LIMIT 1`
    )
    .get(campaign_name);

  res.type('text/plain').send(row?.final_url || '');
});

app.use((err, req, res, next) => {
  console.error('服务器内部错误:', err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`Google Ads Linker running at ${BASE_URL}`);
  console.log(`Admin panel: ${BASE_URL}/linklist.html`);
});

module.exports = { app, db, processTask };