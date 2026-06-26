<div align="center">

# AlphaNexus

**投資組合管理平台**

![Node.js](https://img.shields.io/badge/Node.js-≥18-339933?logo=node.js&logoColor=white)
![Zero Deps](https://img.shields.io/badge/依賴-零依賴-blue)
![License](https://img.shields.io/badge/License-PolyForm--NC--1.0-purple)
![Tests](https://img.shields.io/badge/Tests-158✓-brightgreen)

**中文** | [简体中文](README.zh-CN.md) | [English](README.en.md) | [日本語](README.ja.md)

</div>

## 系統介面

👉 [前往 Live Demo](https://www.alphanexus.cc) 體驗完整功能（訪客模式免註冊即可使用）。

|  |  |
|:---:|:---:|
| ![](docs/screenshots/01.jpeg) | ![](docs/screenshots/02.jpeg) |
| ![](docs/screenshots/03.jpeg) | ![](docs/screenshots/04.jpeg) |
| ![](docs/screenshots/05.jpeg) | ![](docs/screenshots/06.jpeg) |
| ![](docs/screenshots/07.jpg) | ![](docs/screenshots/08.jpeg) |
| ![](docs/screenshots/09.jpeg) | ![](docs/screenshots/10.jpeg) |

---

一個**手機優先**的多語言投資組合追蹤平台。單一 HTML 前端 + 零依賴 Node.js 後端，專注於跨市場、多幣種的精準會計與績效分析。最低配 VPS 即可運行，也能離線以 `file://` 開啟。

> ⚠️ **免責聲明**：本平台為個人理財追蹤工具，所有市場數據、匯率與新聞均來自第三方來源，僅供參考，**不構成任何投資建議**。

---

## ✨ 為什麼選擇 AlphaNexus？

<table>
<tr>
<td width="50%">

### 🏗️ 零依賴架構
後端僅用 Node.js 內建模組，無需 `npm install`。一個 `server.js` 搞定一切——部署、擴展、維護都極簡。

</td>
<td width="50%">

### 📱 手機優先設計
觸控熱區 ≥44dp、手勢圖表、底部分頁導覽。手機、平板、桌面三端自適應。

</td>
</tr>
<tr>
<td>

### 🌍 四語即時切換
繁體中文、簡體中文、English、日本語。語系包外置 JSON，離線有內嵌兜底。

</td>
<td>

### 🔒 安全帳號系統
scrypt 密碼雜湊 + Bearer Token + 可選郵箱驗證 + 登入防暴力破解 + HSTS/CSP 安全 Headers。

</td>
</tr>
</table>

---

## 🚀 核心功能

### 📊 精準會計引擎

| 特色 | 說明 |
|:---|:---|
| **原始價計價** | 拆股已調整、股息未調整，避免淨值扭曲 |
| **自動股息入帳** | 除淨日按持倉自動入帳，稅後金額精確計算 |
| **拆股重述** | 交易單位數自動調整，用戶紀錄不被改寫 |
| **TWR / MWR** | 時間加權與資金加權(XIRR)雙指標，累積+年化 |
| **九種交易類型** | 股票/債券/現金/期權/其他/股息/利息/費用/負債 |

### 🌐 跨市場・多幣種

```
美股/ETF  ·  港股  ·  A股  ·  日股  ·  加密貨幣
         ↓ 歷史匯率自動折算 ↓
        統一基準貨幣顯示
```

### 📈 圖表與分析

- **四種圖表形態**：折線、平滑曲線、陰陽燭（日/週/月/年聚合）
- **手勢操作**：雙指捏合縮放、單指拖動平移、長按掃描查值
- **12 項技術指標**：SMA、EMA、RSI、MACD、布林帶、KD、VWAP、ATR、OBV、ADX、Parabolic SAR、一目均衡表
- **基準對比**：疊加任意 ETF/股票（SPY、VT 等）的總報酬曲線
- **事件標註**：除淨日 💰、拆股 ✂️ 標於圖表 X 軸

### 🧠 追蹤投資大師

接美國 SEC EDGAR 13F 公開申報，追蹤 **13 位大師**的季度持倉變動：

| 大師 | 機構 | 大師 | 機構 |
|:---:|:---:|:---:|:---:|
| 巴菲特 | Berkshire | Dalio | Bridgewater |
| 李錄 | Himalaya | Loeb | Third Point |
| Tepper | Appaloosa | Klarman | Baupost |
| Ackman | Pershing | Burry | Scion |
| Druckenmiller | Duquesne | Griffin | Citadel |
| Cohen | Point72 | Coleman | Tiger Global |
| Wood | ARK | | |

- CUSIP 自動解析為股票代碼（OpenFIGI API）
- 大師淨值曲線疊合對比
- 季度持倉差異分析（增持/減持/新建/清倉）

### 💰 股息行事曆

- 月度股息預估（過去 12 個月實際推算）
- 除淨日時間軸：向上 = 過去真實行動，向下 = 未來假想除淨日
- 僅顯示有持倉的股票

### 📰 智慧新聞

- 按市場自動路由：港股/A股→中文、日股→日文、美股→英文
- 僅顯示標題、來源、時間，點擊導向原文——不轉載內文

### 🔐 私隱與分享

- **一鍵私隱模式**：隱藏所有金額（顯示為 •••），比率與股價照常
- **分享成績卡**：只含報酬率、不含金額，Canvas 輸出 PNG

---

## ⚡ 快速開始

需要 **Node.js 18+**（內建 `fetch`），無需 `npm install`。

```bash
git clone https://github.com/capturesir/alphanexus.git
cd alphanexus
node server.js
# → http://localhost:8080
```

首次開啟可選「訪客模式」並載入示範組合即時體驗。投資大師數據會在首次啟動時自動建檔（約 10–15 分鐘），之後每季度自動更新。

### 環境變數

| 變數 | 說明 | 預設 |
|---|---|---|
| `PORT` | 伺服器埠 | 8080 |
| `CORS_ORIGIN` | 允許的前端來源（逗號分隔） | 空 = 全部允許 |
| | ⚠️ 上線務必設定，例如 `https://www.alphanexus.cc`，防止任意網站呼叫你的 API |
| `SMTP_*` | 郵箱驗證（HOST/PORT/USER/PASS/FROM） | 未設定 = 免驗證 |
| `NEWS_PROVIDER` | 新聞來源：`rss` / `newsapi` / `marketaux` | Yahoo 聚合 |
| `PREFETCH_HOUR` | 每日預抓時間（-1 停用） | 5 |

---

## 🧪 測試

```bash
npm test    # 引擎 101 + 後端 57 = 158 項 ✓
```

涵蓋：除淨日淨值恆等、拆股重述、期權中立、費用處理、自動股息、MWR、數據源備援、增量合併、JSONPath、CoinGecko、CUSIP 對映。

---

## 🏗️ 技術棧

| 層級 | 技術 |
|:---|:---|
| 前端 | 原生 HTML/CSS/JS，Canvas 自繪圖表，無框架、無建構 |
| 後端 | Node.js 內建模組（http/crypto/tls/zlib/fs），零第三方依賴 |
| 儲存 | JSON 檔案（原子寫入）+ 兩層快取（記憶體 + 磁碟） |
| 數據源 | Yahoo Finance → Stooq → CoinGecko 備援鏈 |
| 安全 | scrypt、Bearer Token、HSTS、X-Frame-Options、速率限制 |

---

## 📦 部署

最低配 VPS（1 vCPU / 1GB RAM，月費 ~US$4–6）即可運行。

```bash
# VPS 上
git clone https://github.com/capturesir/alphanexus.git
cd alphanexus
pm2 start server.js --name alphanexus   # 首次啟動自動建檔大師數據
pm2 save
```

建議前置 Cloudflare 免費方案抵禦 DDoS。完整教學見 DEPLOY.md（本地私有，不隨 git 發佈）。

---

## 📁 專案結構

```
alphanexus/
├── server.js          # 零依賴 Node.js 後端（~1500 行）
├── public/
│   ├── index.html     # 前端單檔（含全部 CSS/JS）
│   └── i18n/          # 語系包 zh-Hant / zh-Hans / en / ja
├── test/              # 回歸測試（引擎 + 後端）
├── scripts/           # 輔助腳本（PDF 生成等）
├── docs/screenshots/  # 系統介面截圖（README 引用）
├── package.json
├── LICENSE            # PolyForm Noncommercial 1.0.0
└── data/              # 執行期自動建立（不入 git）
```

---

## 📜 授權

[PolyForm Noncommercial License 1.0.0](LICENSE) — 非商用免費開源，商用需取得作者同意。

## ✉️ 聯絡

- 作者：Capture
- Email：capturesir@gmail.com
- 問題回報：歡迎開 issue 或來信

---

<div align="center">

**架構參考**：[Ghostfolio](https://github.com/ghostfolio/ghostfolio) · [Portfolio Performance](https://github.com/portfolio-performance/portfolio)

</div>
