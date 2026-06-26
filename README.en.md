<div align="center">

# AlphaNexus

**Portfolio Management Platform**

![Node.js](https://img.shields.io/badge/Node.js-≥18-339933?logo=node.js&logoColor=white)
![Zero Deps](https://img.shields.io/badge/deps-zero-blue)
![License](https://img.shields.io/badge/License-PolyForm--NC--1.0-purple)
![Tests](https://img.shields.io/badge/Tests-158✓-brightgreen)

[中文](README.md) | [简体中文](README.zh-CN.md) | **English** | [日本語](README.ja.md)

</div>

## System Interface

👉 [Try the Live Demo](https://www.alphanexus.cc) — guest mode available, no registration required.

|  |  |
|:---:|:---:|
| ![](docs/screenshots/01.jpeg) | ![](docs/screenshots/02.jpeg) |
| ![](docs/screenshots/03.jpeg) | ![](docs/screenshots/04.jpeg) |
| ![](docs/screenshots/05.jpeg) | ![](docs/screenshots/06.jpeg) |
| ![](docs/screenshots/07.jpg) | ![](docs/screenshots/08.jpeg) |
| ![](docs/screenshots/09.jpeg) | ![](docs/screenshots/10.jpeg) |

---

A **mobile-first**, multilingual portfolio tracker. Single-file HTML frontend + zero-dependency Node.js backend, focused on cross-market, multi-currency precision accounting and performance analytics. Runs on the cheapest VPS, or offline via `file://`.

> ⚠️ **Disclaimer**: This is a personal finance tracking tool. All market data, FX rates and news come from third-party sources, are for reference only, and **do not constitute investment advice**.

---

## ✨ Why AlphaNexus?

<table>
<tr>
<td width="50%">

### 🏗️ Zero Dependencies
Backend uses only Node.js built-ins. No `npm install`. One `server.js` does it all — deploy, scale, and maintain with minimal effort.

</td>
<td width="50%">

### 📱 Mobile-First Design
≥44dp touch targets, gesture-driven charts, bottom tab navigation. Responsive across phone, tablet, and desktop.

</td>
</tr>
<tr>
<td>

### 🌍 4 Languages, Instant Switch
Traditional Chinese, Simplified Chinese, English, Japanese. External JSON packs with embedded fallback for offline use.

</td>
<td>

### 🔒 Secure Auth
scrypt password hashing + Bearer tokens + optional email verification + brute-force protection + HSTS/security headers.

</td>
</tr>
</table>

---

## 🚀 Core Features

### 📊 Precision Accounting Engine

| Feature | Description |
|:---|:---|
| **Raw-price valuation** | Split-adjusted, dividend-unadjusted — no NAV distortion |
| **Auto-dividends** | Booked on ex-date pro-rata by holdings, after-tax precision |
| **Split restatement** | Units auto-adjusted, user records never rewritten |
| **TWR / MWR** | Time-weighted & money-weighted (XIRR), cumulative + annualized |
| **9 activity types** | Stock/Bond/Cash/Option/Other/Dividend/Interest/Fee/Liability |

### 🌐 Cross-Market · Multi-Currency

```
US Stocks/ETFs  ·  HK  ·  China A-Shares  ·  Japan  ·  Crypto
              ↓ Historical FX auto-conversion ↓
           Unified base currency display
```

### 📈 Charts & Analysis

- **4 chart types**: line, smooth curve, candlestick (daily/weekly/monthly/yearly)
- **Gesture controls**: pinch-zoom, pan, long-press scrub for values
- **12 technical indicators**: SMA, EMA, RSI, MACD, Bollinger Bands, KD, VWAP, ATR, OBV, ADX, Parabolic SAR, Ichimoku Cloud
- **Benchmark overlay**: compare against any ETF/stock (SPY, VT, etc.) as total-return curves
- **Event markers**: ex-dividend 💰 and splits ✂️ on the chart X-axis

### 🧠 Track Investing Gurus

Powered by US SEC EDGAR 13F filings — track quarterly holdings of **13 legendary investors**:

| Guru | Firm | Guru | Firm |
|:---:|:---:|:---:|:---:|
| Buffett | Berkshire | Dalio | Bridgewater |
| Li Lu | Himalaya | Loeb | Third Point |
| Tepper | Appaloosa | Klarman | Baupost |
| Ackman | Pershing | Burry | Scion |
| Druckenmiller | Duquesne | Griffin | Citadel |
| Cohen | Point72 | Coleman | Tiger Global |
| Wood | ARK | | |

- Auto CUSIP → ticker resolution via OpenFIGI API
- Guru NAV curve overlay for comparison
- Quarter-over-quarter holdings diff (increased/decreased/new/closed)

### 💰 Dividend Calendar

- Monthly dividend estimates (trailing-12-month actuals)
- Ex-dividend timeline: past year real actions ↑, hypothetical future dates ↓
- Only shows symbols you hold

### 📰 Smart News

- Auto-routed by market: HK/A-shares → Chinese, Japan → Japanese, US → English
- Shows headline, source, time only — links to original, no content reproduction

### 🔐 Privacy & Sharing

- **One-tap privacy mode**: hides all amounts (shown as •••), ratios and prices stay visible
- **Share returns card**: amounts-free performance card, rendered to PNG via Canvas

---

## ⚡ Quick Start

Requires **Node.js 18+** (built-in `fetch`). No `npm install` needed.

```bash
git clone https://github.com/capturesir/alphanexus.git
cd alphanexus
node server.js
# → http://localhost:8080
```

Choose "Guest mode" and load the demo portfolio to explore instantly. Guru data auto-builds on first launch (~10–15 min) and auto-updates quarterly.

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | 8080 |
| `CORS_ORIGIN` | Allowed frontend origins (comma-separated) | empty = all |
| | ⚠️ Set this in production, e.g. `https://www.alphanexus.cc`, to prevent other sites from calling your API |
| `SMTP_*` | Email verification (HOST/PORT/USER/PASS/FROM) | unset = no verification |
| `NEWS_PROVIDER` | News source: `rss` / `newsapi` / `marketaux` | Yahoo aggregation |
| `PREFETCH_HOUR` | Daily prefetch hour (-1 to disable) | 5 |

---

## 🧪 Testing

```bash
npm test    # engine 101 + backend 57 = 158 checks ✓
```

Covers: ex-date NAV invariance, split restatement, option neutrality, fee handling, auto-dividends, MWR, quote fallback chain, incremental merge, JSONPath, CoinGecko, CUSIP mapping.

---

## 🏗️ Tech Stack

| Layer | Technology |
|:---|:---|
| Frontend | Vanilla HTML/CSS/JS, Canvas-drawn charts, no framework, no build step |
| Backend | Node.js built-ins (http/crypto/tls/zlib/fs), zero third-party deps |
| Storage | JSON files (atomic writes) + two-layer cache (memory + disk) |
| Data Sources | Yahoo Finance → Stooq → CoinGecko fallback chain |
| Security | scrypt, Bearer tokens, HSTS, X-Frame-Options, rate limiting |

---

## 📦 Deployment

An entry-level VPS (1 vCPU / 1GB RAM, ~US$4–6/mo) is sufficient.

```bash
# On VPS
git clone https://github.com/capturesir/alphanexus.git
cd alphanexus
pm2 start server.js --name alphanexus   # auto-builds guru data on first launch
pm2 save
```

Cloudflare free tier recommended for DDoS protection. Full guide in DEPLOY.md (local-only, not shipped in git).

---

## 📁 Project Structure

```
alphanexus/
├── server.js          # Zero-dep Node.js backend (~1500 lines)
├── public/
│   ├── index.html     # Single-file frontend (all CSS/JS)
│   └── i18n/          # Language packs zh-Hant / zh-Hans / en / ja
├── test/              # Regression tests (engine + backend)
├── scripts/           # Helper scripts (PDF generation, etc.)
├── docs/screenshots/  # System interface screenshots (used in README)
├── package.json
├── LICENSE            # PolyForm Noncommercial 1.0.0
└── data/              # Auto-created at runtime (not in git)
```

---

## 📜 License

[PolyForm Noncommercial License 1.0.0](LICENSE) — free for noncommercial use; commercial use requires the author's permission.

## ✉️ Contact

- Author: Capture
- Email: capturesir@gmail.com
- Issues & suggestions: open an issue or reach out via email

---

<div align="center">

**Architecture inspired by**: [Ghostfolio](https://github.com/ghostfolio/ghostfolio) · [Portfolio Performance](https://github.com/portfolio-performance/portfolio)

</div>
