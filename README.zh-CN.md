<div align="center">

# AlphaNexus

**投资组合管理平台**

![Node.js](https://img.shields.io/badge/Node.js-≥18-339933?logo=node.js&logoColor=white)
![Zero Deps](https://img.shields.io/badge/依赖-零依赖-blue)
![License](https://img.shields.io/badge/License-PolyForm--NC--1.0-purple)
![Tests](https://img.shields.io/badge/Tests-158✓-brightgreen)

[中文](README.md) | **简体中文** | [English](README.en.md) | [日本語](README.ja.md)

</div>

## 系统界面

👉 [前往 Live Demo](https://www.alphanexus.cc) 体验完整功能（访客模式免注册即可使用）。

|  |  |
|:---:|:---:|
| ![](docs/screenshots/01.jpeg) | ![](docs/screenshots/02.jpeg) |
| ![](docs/screenshots/03.jpeg) | ![](docs/screenshots/04.jpeg) |
| ![](docs/screenshots/05.jpeg) | ![](docs/screenshots/06.jpeg) |
| ![](docs/screenshots/07.jpg) | ![](docs/screenshots/08.jpeg) |
| ![](docs/screenshots/09.jpeg) | ![](docs/screenshots/10.jpeg) |

---

一个**手机优先**的多语言投资组合追踪平台。单一 HTML 前端 + 零依赖 Node.js 后端，专注于跨市场、多币种的精准会计与绩效分析。最低配 VPS 即可运行，也能离线以 `file://` 开启。

> ⚠️ **免责声明**：本平台为个人理财追踪工具，所有市场数据、汇率与新闻均来自第三方来源，仅供参考，**不构成任何投资建议**。

---

## ✨ 为什么选择 AlphaNexus？

<table>
<tr>
<td width="50%">

### 🏗️ 零依赖架构
后端仅用 Node.js 内建模块，无需 `npm install`。一个 `server.js` 搞定一切——部署、扩展、维护都极简。

</td>
<td width="50%">

### 📱 手机优先设计
触控热区 ≥44dp、手势图表、底部分页导航。手机、平板、桌面三端自适应。

</td>
</tr>
<tr>
<td>

### 🌍 四语即时切换
繁体中文、简体中文、English、日本语。语系包外置 JSON，离线有内嵌兜底。

</td>
<td>

### 🔒 安全账号系统
scrypt 密码杂凑 + Bearer Token + 可选邮箱验证 + 登录防暴力破解 + HSTS 安全 Headers。

</td>
</tr>
</table>

---

## 🚀 核心功能

### 📊 精准会计引擎

| 特色 | 说明 |
|:---|:---|
| **原始价计价** | 拆股已调整、股息未调整，避免净值扭曲 |
| **自动股息入账** | 除净日按持仓自动入账，税后金额精确计算 |
| **拆股重述** | 交易单位数自动调整，用户记录不被改写 |
| **TWR / MWR** | 时间加权与资金加权(XIRR)双指标，累积+年化 |
| **九种交易类型** | 股票/债券/现金/期权/其他/股息/利息/费用/负债 |

### 🌐 跨市场 · 多币种

```
美股/ETF  ·  港股  ·  A股  ·  日股  ·  加密货币
         ↓ 历史汇率自动折算 ↓
        统一基准货币显示
```

### 📈 图表与分析

- **四种图表形态**：折线、平滑曲线、阴阳烛（日/周/月/年聚合）
- **手势操作**：双指捏合缩放、单指拖动平移、长按扫描查值
- **12 项技术指标**：SMA、EMA、RSI、MACD、布林带、KD、VWAP、ATR、OBV、ADX、Parabolic SAR、一目均衡表
- **基准对比**：叠加任意 ETF/股票（SPY、VT 等）的总回报曲线
- **事件标注**：除净日 💰、拆股 ✂️ 标于图表 X 轴

### 🧠 追踪投资大师

接美国 SEC EDGAR 13F 公开申报，追踪 **13 位大师**的季度持仓变动：

| 大师 | 机构 | 大师 | 机构 |
|:---:|:---:|:---:|:---:|
| 巴菲特 | Berkshire | Dalio | Bridgewater |
| 李录 | Himalaya | Loeb | Third Point |
| Tepper | Appaloosa | Klarman | Baupost |
| Ackman | Pershing | Burry | Scion |
| Druckenmiller | Duquesne | Griffin | Citadel |
| Cohen | Point72 | Coleman | Tiger Global |
| Wood | ARK | | |

- CUSIP 自动解析为股票代码（OpenFIGI API）
- 大师净值曲线叠加对比
- 季度持仓差异分析（增持/减持/新建/清仓）

### 💰 股息日历

- 月度股息预估（过去 12 个月实际推算）
- 除净日时间轴：向上 = 过去真实行动，向下 = 未来假想除净日
- 仅显示有持仓的股票

### 📰 智慧新闻

- 按市场自动路由：港股/A股→中文、日股→日文、美股→英文
- 仅显示标题、来源、时间，点击导向原文——不转载内文

### 🔐 隐私与分享

- **一键隐私模式**：隐藏所有金额（显示为 •••），比率与股价照常
- **分享成绩卡**：只含回报率、不含金额，Canvas 输出 PNG

---

## ⚡ 快速开始

需要 **Node.js 18+**（内建 `fetch`），无需 `npm install`。

```bash
git clone https://github.com/capturesir/alphanexus.git
cd alphanexus
node server.js
# → http://localhost:8080
```

首次开启可选「访客模式」并加载示范组合即时体验。投资大师数据会在首次启动时自动建档（约 10–15 分钟），之后每季度自动更新。

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 服务器端口 | 8080 |
| `CORS_ORIGIN` | 允许的前端来源（逗号分隔） | 空 = 全部允许 |
| `SMTP_*` | 邮箱验证（HOST/PORT/USER/PASS/FROM） | 未设定 = 免验证 |
| `NEWS_PROVIDER` | 新闻来源：`rss` / `newsapi` / `marketaux` | Yahoo 聚合 |
| `PREFETCH_HOUR` | 每日预抓时间（-1 停用） | 5 |

---

## 🧪 测试

```bash
npm test    # 引擎 101 + 后端 57 = 158 项 ✓
```

涵盖：除净日净值恒等、拆股重述、期权中立、费用处理、自动股息、MWR、数据源备援、增量合并、JSONPath、CoinGecko、CUSIP 对映。

---

## 🏗️ 技术栈

| 层级 | 技术 |
|:---|:---|
| 前端 | 原生 HTML/CSS/JS，Canvas 自绘图表，无框架、无构建 |
| 后端 | Node.js 内建模块（http/crypto/tls/zlib/fs），零第三方依赖 |
| 储存 | JSON 文件（原子写入）+ 两层缓存（内存 + 磁盘） |
| 数据源 | Yahoo Finance → Stooq → CoinGecko 备援链 |
| 安全 | scrypt、Bearer Token、HSTS、X-Frame-Options、速率限制 |

---

## 📦 部署

最低配 VPS（1 vCPU / 1GB RAM，月费 ~US$4–6）即可运行。

```bash
# VPS 上
git clone https://github.com/capturesir/alphanexus.git
cd alphanexus
pm2 start server.js --name alphanexus   # 首次启动自动建档大师数据
pm2 save
```

建议前置 Cloudflare 免费方案抵御 DDoS。完整教学见 DEPLOY.md（本地私有，不随 git 发布）。

---

## 📁 项目结构

```
alphanexus/
├── server.js          # 零依赖 Node.js 后端（~1500 行）
├── public/
│   ├── index.html     # 前端单档（含全部 CSS/JS）
│   └── i18n/          # 语系包 zh-Hant / zh-Hans / en / ja
├── test/              # 回归测试（引擎 + 后端）
├── package.json
└── data/              # 运行期自动建立（不入 git）
```

---

## 📜 授权

[PolyForm Noncommercial License 1.0.0](LICENSE) — 非商用免费开源，商用需取得作者同意。

## ✉️ 联络

- 作者：Capture
- Email：capturesir@gmail.com
- 问题回报：欢迎开 issue 或来信

---

<div align="center">

**架构参考**：[Ghostfolio](https://github.com/ghostfolio/ghostfolio) · [Portfolio Performance](https://github.com/portfolio-performance/portfolio)

</div>
