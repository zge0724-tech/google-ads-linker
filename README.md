# Google Ads 自动化换链与流量洗路系统

Node.js + Express + SQLite 实现的联盟链接解析、域名校验与 Google Ads 换链 API。

## 功能

- **管理后台** (`/linklist.html`)：创建/编辑/删除换链任务，BrandBidding 风格界面
- **定时洗路**：按运行频率 + 24 小时时间点，通过代理请求联盟链接并跟随 301/302 重定向
- **域名校验**：Final URL 必须包含预期落地页域名才写入数据库
- **Google Ads 接口**：`GET /ashx/gettemplate.ashx?campaign_name=xxx` 返回纯文本 Final URL

## 快速开始

```bash
npm install
npm start
```

浏览器打开：http://localhost:3000/linklist.html

### 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `PORT` | 服务端口 | `3000` |
| `BASE_URL` | 对外 API 根路径（部署时改为公网地址） | `http://localhost:3000` |

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/info` | API 根路径信息 |
| GET | `/api/tasks` | 任务列表 |
| POST | `/api/tasks` | 创建任务 |
| PUT | `/api/tasks/:id` | 更新任务 |
| DELETE | `/api/tasks/:id` | 删除任务 |
| POST | `/api/tasks/:id/run` | 手动立即运行 |
| GET | `/ashx/gettemplate.ashx?campaign_name=xxx` | Google Ads 脚本拉取 Final URL |
| GET | `/api/ads-script` | 获取 Google Ads 换链脚本 |

## Google Ads 脚本

1. 在管理后台点击「一键复制 Google Ads 脚本」
2. 粘贴到 Google Ads → 工具与设置 → 批量操作 → 脚本
3. 设置定时运行（建议每日）
4. 确保脚本中 `campaignName` 与任务里的「广告系列名称」一致

## 代理格式

```
http://user:pass@host:port
```

## 数据存储

SQLite 数据库文件：`data.db`（首次运行自动创建）
