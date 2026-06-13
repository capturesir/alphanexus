# WealthLens — Investment Portfolio Management Platform (Full-Stack)

[中文](README.md) | **English**

A mobile-first, multi-language (Traditional Chinese / Simplified Chinese / English) portfolio tracking platform with live and historical market data, TWR/MWR performance metrics, multi-currency conversion, gesture-enabled charts (pinch-to-zoom / drag), ETF comparison, user authentication, and cloud sync.

## Screenshots

| Asset List | Performance Chart |
|:---:|:---:|
| ![Asset List](docs/screenshots/asset-list.jpeg) | ![Performance Chart](docs/screenshots/performance-chart.jpeg) |

| News | Settings |
|:---:|:---:|
| ![News](docs/screenshots/news.jpeg) | ![Settings](docs/screenshots/settings.jpeg) |

## Project Structure

```
wealthlens/
├── server.js          # Zero-dependency Node.js backend (>= Node 18, no npm install needed)
├── public/
│   └── index.html     # Frontend (single file, all CSS/JS inline)
├── package.json
└── data/              # Auto-created at startup: users, portfolios, data cache
```

## Quick Start

```bash
node server.js          # Default: http://localhost:8080
PORT=3000 node server.js  # Custom port
```

Open your browser at http://localhost:8080. **Zero dependencies** — no `npm install` needed, just Node.js 18+ (with built-in fetch).

## Deployment / Email Verification / Security

- Step-by-step VPS deployment guide (reverse proxy + auto HTTPS + backup + Cloudflare): see **DEPLOY.md**.
- **Email verification**: Set `SMTP_HOST / SMTP_PORT(465) / SMTP_USER / SMTP_PASS / SMTP_FROM` to enable — sends a 6-digit code on registration (15min expiry, 60s resend throttle, 5-fail lockout); account created only after verification. Without SMTP set, no verification is required (self-hosted personal use).
- **Traffic optimization**: API JSON and text static files >1KB are automatically gzip-compressed (historical sequences shrink 8–12×, homepage 3×).
- **Resilience**: Concurrent request coalescing (1 upstream call per symbol), 240 requests/min per IP rate limit, 30s slow-request timeout, 7-day auto-eviction for short-lived cache. For DDoS protection, place Cloudflare in front (see DEPLOY.md Step 8).

## Accounting Model (Raw Price + Internal Cash Transfer)

- **Pricing**: Personal portfolio NAV/TWR/MWR/candlestick charts always use **raw price** (split-adjusted, dividend-unadjusted). Benchmark comparison uniquely uses **adjusted price** (representing total return).
- **Auto dividends**: On ex-dividend date, the system auto-creates a DIVIDEND transaction per holding: `after-tax = shares × DPS × (1 − withholding rate)`. Withholding rate: per-tx override → global setting → 0%. Auto entries marked ⚡; editing converts to manual; deletion adds to skip list; deduplication within ±14 days for the same symbol.
- **Stock splits**: Transaction units restated (units × F, price ÷ F, where F = cumulative split ratio after trade date). User records are never modified; NAV and cost basis remain smooth.
- **Options**: Excluded from historical charts and TWR/MWR. Cash in/out treated as external flows (fully neutral). Listed at last manually entered settlement price. Chart displays "Excludes current option value ±X" note.
- **FEE / LIABILITY**: Internal expenses — reduce cash, not counted as external flows, naturally suppress return rate. TWR formula: V₁/(V₀+C); fees are not double-counted.
- **Event annotations**: Gold dots (Div) / blue squares (Split) on the asset value chart. Crosshair hover shows detail tooltips.

## Data Architecture

Inspired by Ghostfolio and Portfolio Performance:

**Data source fallback chain** — each data type has primary and backup sources; a single service outage won't break the platform:

| Data | Primary | Backup | Last Resort |
|---|---|---|---|
| Historical prices (adj + div/split events) | Yahoo Finance | Local stale cache | Stooq (US/HK/JP, split-adjusted) |
| FX rates | Yahoo {CCY}=X | Local stale cache | Frankfurter / ECB (excl. TWD) |
| Symbol search | Yahoo | Built-in 33-symbol list | — |

**Persistence + incremental updates** — Historical data stored in `data/market/`. Within 30 minutes, served directly from cache; after expiry, only fetches the gap after the last candle (with 2-week overlap window), reducing API requests by 95%+. If new dividend/split events are detected in the incremental window, a full re-fetch is triggered.

**Dividend/split events** — `/api/history` response includes `dividends[]`, `splits[]`, `source`, `adjusted`, `stale` fields. Frontend uses these to display "past year dividends" per holding.

**Trading model** — Buy/sell transactions support `fee` (commission, included in cost on buy, deducted from cash on sell). New "dividend" and "interest" transaction types count toward cash and return rate but are not treated as external flows, so TWR/MWR reflect total return including distributions.

**Custom JSONPath data sources (#5)** — Inspired by PP's JSON Quote Feed: provide any API URL + date path + price path (JSONPath, supports `$.a.b[*].c`, `['key']`, `[N]`) in "Personal Center → Custom Data Sources" to connect historical prices for any fund/bond/financial product. Date format auto-detected (ISO, Unix sec/ms, MM/DD/YYYY). Built-in "Test" button for live preview; server-side SSRF protection (rejects internal network addresses). Custom sources take priority over Yahoo in the price resolution chain.

**Nightly prefetch (#6)** — Server daily at `PREFETCH_HOUR` (default Taipei 05:00, set -1 to disable) scans all user portfolios and custom sources, updating at 0.8s intervals for a "load instantly" experience the next morning.

**Cryptocurrency (#7)** — `BTC-USD`, `ETH-USD` etc. primarily via Yahoo; on failure, auto-fallback to CoinGecko (no API key required).

**CSV import/export (#8)** — "Personal Center → Transaction CSV". Export includes all fields (kind/sym/ccy/loc/side/price/units/amount/fee/date); import supports both this platform's format and Ghostfolio-style headers (type/symbol/quantity/unitPrice/currency; DIVIDEND rows auto-convert unitPrice×quantity to amount). Choose replace or merge mode.

## Live Data Sources

Backend proxies Yahoo Finance public endpoints; frontend loads on demand:

| Data | Endpoint | Coverage | Cache |
|---|---|---|---|
| Historical daily (raw + adjusted close) | `/api/history?symbol=` | US stocks/ETFs, HK `.HK`, A-shares `.SS`/`.SZ`, JP `.T`, TW `.TW` | 6 hours |
| FX rate history (1 USD = ? CCY) | `/api/fx?ccys=HKD,JPY,...` | HKD/JPY/CNY/TWD/EUR/GBP | 6 hours |
| Symbol search (autocomplete) | `/api/search?q=` | Global; type VT to see VT/VTI/... | 24 hours |
| Holdings-related + trending financial news | `/api/news?symbols=` | Yahoo Finance news | 10 minutes |

The top bar shows "Live Data / Simulated Data" status:
- Accessed via `http(s)://` from this server → automatically enters **Live Data** mode
- Double-click to open `index.html` (`file://`) or backend unreachable → falls back to **Simulated Data** mode; UI works as normal
- Individual symbol fetch failure (e.g., options, delisted) → valued at last traded price; does not affect overall calculations

## Account & Sync

- Register/Login: `scrypt` password hashing + Bearer token; changing password logs out other devices
- After login, transactions and preferences auto-sync to the server (`data/portfolios/`); log in on another device to restore
- Guest mode: data stored locally only; auto-loads demo portfolio
- Frontend email input: registered → login; not registered → auto-create account

## Deploy to Public Internet

Any environment that can run Node.js:

**VPS (recommended with pm2 + reverse proxy)**
```bash
npm i -g pm2
pm2 start server.js --name wealthlens
# Use Nginx/Caddy to reverse proxy 8080 with HTTPS
```

**Render / Railway / Fly.io**: Leave Build command blank, Start command `node server.js`, set `PORT` via platform injection.

Note: Yahoo is an unofficial public API. For high-traffic or commercial use, consider switching to a paid data provider (Polygon, Twelve Data, EODHD, etc.) — just rewrite the four functions `getHistory / getFx / searchSymbols / getNews` in `server.js`; frontend needs no changes.

## License

This project is licensed under the [MIT License](LICENSE).

This project was independently built from scratch, with design inspiration drawn from:
- [Ghostfolio](https://github.com/ghostfolio/ghostfolio) (AGPL-3.0)
- [Portfolio Performance](https://github.com/portfolio-performance/portfolio) (EPL-1.0)

## Other

- Rate limiting: 240 API requests per IP per minute
- Option symbols (e.g., AAPL260618C200) have no public historical source; valued at last traded price
- TWR uses chain-linking with cash flow segmentation; MWR is XIRR (annualized); both calculated using adjusted price
