#!/usr/bin/env node
/* =========================================================================
   AlphaNexus Server v0.1 — 零依賴 Node.js (>=18) 後端
   本版升級(借鏡 Ghostfolio / Portfolio Performance 架構):
   1. 數據源抽象層 + 備援鏈:
        歷史價  : Yahoo Finance(主) → Stooq(備,美/港/日股)→ 過期庫存
        匯率    : Yahoo {CCY}=X(主) → Frankfurter/ECB(備) → 過期庫存
        代碼搜尋: Yahoo(前端另有內置清單兜底)
   2. 市場數據持久化 + 增量更新:
        全量歷史寫入 data/market/,之後只抓最後一根K線後的缺口;
        若增量視窗內偵測到新的股息/拆股事件 → 觸發全量重抓(調整價會回溯變動)
   3. 股息 / 拆股事件解析:history 回應附 dividends[] / splits[]
   4. 其餘:帳號系統、組合同步、新聞、靜態檔案 — 與 v2.0 相同
   啟動:  node server.js   (PORT 環境變數可改埠, 預設 8080)
   ========================================================================= */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
const ROOT = __dirname;
const PUB = path.join(ROOT, "public");
const DATA = process.env.WL_DATA_DIR ? path.resolve(process.env.WL_DATA_DIR) : path.join(ROOT, "data");
const CACHE_DIR = path.join(DATA, "cache");    // 短效快取(搜尋/新聞)
const MARKET_DIR = path.join(DATA, "market");  // 市場數據持久庫(歷史價/匯率)
const PORT_DIR = path.join(DATA, "portfolios");
const GURU_DIR = path.join(DATA, "gurus");      // 投資大師持倉/淨值持久化(市場數據類,全站共用、唯讀)
for (const d of [DATA, CACHE_DIR, MARKET_DIR, PORT_DIR, GURU_DIR]) fs.mkdirSync(d, { recursive: true });

/* ---------------------- 小工具 ---------------------- */
const log = (...a) => console.log(new Date().toISOString(), ...a);
function readJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch (e) { return fb } }
function writeJSON(p, obj) { // 原子寫入
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = p + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}
const sha1 = s => crypto.createHash("sha1").update(s).digest("hex");
const tsToDate = ts => new Date(ts * 1000).toISOString().slice(0, 10);
const dateToTs = d => Math.floor(new Date(d + "T00:00:00Z").getTime() / 1000);
const todayStr = () => new Date().toISOString().slice(0, 10);

/* ---------------------- 短效快取 (記憶體 + 磁碟) ---------------------- */
const MEM_CACHE = new Map();
function cacheGet(key, ttlMs) {
  const m = MEM_CACHE.get(key);
  if (m && Date.now() - m.at < ttlMs) return m.val;
  const f = path.join(CACHE_DIR, sha1(key) + ".json");
  try {
    const st = fs.statSync(f);
    if (Date.now() - st.mtimeMs < ttlMs) {
      const val = JSON.parse(fs.readFileSync(f, "utf8"));
      MEM_CACHE.set(key, { at: st.mtimeMs, val });
      return val;
    }
  } catch (e) {}
  return null;
}
function cacheSet(key, val) {
  MEM_CACHE.set(key, { at: Date.now(), val });
  try { writeJSON(path.join(CACHE_DIR, sha1(key) + ".json"), val) } catch (e) {}
}
const TTL = { search: 24 * 3600e3, news: 10 * 60e3 };
const FRESH_MS = +(process.env.MARKET_FRESH_MS || 30 * 60e3); // 持久庫視為「新鮮」的時間窗

/* ---------------------- 市場數據持久庫 ---------------------- */
function storePath(kind, key) { return path.join(MARKET_DIR, kind + "_" + sha1(key) + ".json") }
function loadStore(kind, key) { return readJSON(storePath(kind, key), null) }
function saveStore(kind, key, doc) { doc.fetchedAt = Date.now(); writeJSON(storePath(kind, key), doc); return doc }

/* 將增量數據併入既有序列:以增量首日切斷舊序列尾段(順便修復重疊窗),再接上增量 */
function mergeSeries(store, inc) {
  if (!inc.dates.length) return store;
  const cutDate = inc.dates[0];
  let cut = store.dates.length;
  while (cut > 0 && store.dates[cut - 1] >= cutDate) cut--;
  const merged = {
    ...store,
    name: inc.name || store.name, ccy: inc.ccy || store.ccy, last: inc.last ?? store.last,
    dates: store.dates.slice(0, cut).concat(inc.dates),
    raw: store.raw.slice(0, cut).concat(inc.raw),
    adj: store.adj.slice(0, cut).concat(inc.adj)
  };
  const evMerge = (a, b) => { const m = new Map(); for (const e of [...(a || []), ...(b || [])]) m.set(e.date, e); return [...m.values()].sort((x, y) => x.date < y.date ? -1 : 1) };
  merged.dividends = evMerge(store.dividends, inc.dividends);
  merged.splits = evMerge(store.splits, inc.splits);
  return merged;
}
/* 增量視窗內是否出現「庫存最後日期之後」的新事件(若有,調整價需全量重抓) */
function hasNewEvents(store, inc) {
  const lastD = store.dates[store.dates.length - 1] || "0000-00-00";
  return [...(inc.dividends || []), ...(inc.splits || [])].some(e => e.date > lastD);
}

/* ---------------------- HTTP 抓取工具 ---------------------- */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
async function fetchAny(urls, asText) {
  let lastErr;
  for (const url of urls) {
    try {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": asText ? "text/*" : "application/json" }, signal: ctl.signal });
      clearTimeout(tm);
      if (!r.ok) { lastErr = new Error("upstream_" + r.status); continue }
      return asText ? await r.text() : await r.json();
    } catch (e) { lastErr = e }
  }
  throw lastErr || new Error("upstream_failed");
}
const YH = p => [`https://query1.finance.yahoo.com${p}`, `https://query2.finance.yahoo.com${p}`];

const EPOCH_FROM = dateToTs("2020-12-28"); // 略早於前端 START_DATE
function mktOf(s) {
  if (/\.HK$/i.test(s)) return "HK";
  if (/\.(SS|SZ)$/i.test(s)) return "CN";
  if (/\.T$/i.test(s)) return "JP";
  if (/\.TWO?$/i.test(s)) return "TW";
  if (/=X$/i.test(s)) return "FX";
  return "US";
}

/* ====================== 數據源 Provider 層 ====================== */
/* 統一輸出: {symbol,name,ccy,market,last,dates[],raw[],adj[],open[],high[],low[],volume[],dividends[],splits[],source,adjusted} */

const providers = {
  /* ---- Yahoo:歷史價(含調整價 + 股息/拆股事件) ---- */
  async yahooHistory(symbol, fromTs) {
    const now = Math.floor(Date.now() / 1000);
    const j = await fetchAny(YH(`/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${fromTs}&period2=${now}&interval=1d&events=div%2Csplit&includeAdjustedClose=true`));
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    if (!res || !res.timestamp) throw new Error("no_data");
    const meta = res.meta || {};
    let ccy = meta.currency || "USD", scale = 1;
    if (ccy === "GBp") { ccy = "GBP"; scale = 0.01 }   // 倫敦便士報價
    if (ccy === "ILA") { ccy = "ILS"; scale = 0.01 }   // 以色列 agorot(借鏡 Ghostfolio 修正)
    const quote = (res.indicators.quote && res.indicators.quote[0]) || {};
    const close = quote.close || [];
    const adjA = (res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose) || close;
    const dates = [], raw = [], adj = [], open = [], high = [], low = [], volume = [];
    for (let i = 0; i < res.timestamp.length; i++) {
      if (close[i] == null && adjA[i] == null) continue;
      dates.push(tsToDate(res.timestamp[i]));
      raw.push(close[i] == null ? null : +(close[i] * scale).toFixed(6));
      adj.push(adjA[i] == null ? null : +(adjA[i] * scale).toFixed(6));
      open.push(quote.open && quote.open[i] != null ? +(quote.open[i] * scale).toFixed(6) : null);
      high.push(quote.high && quote.high[i] != null ? +(quote.high[i] * scale).toFixed(6) : null);
      low.push(quote.low && quote.low[i] != null ? +(quote.low[i] * scale).toFixed(6) : null);
      volume.push(quote.volume && quote.volume[i] != null ? quote.volume[i] : null);
    }
    if (!dates.length) throw new Error("no_data");
    const ev = res.events || {};
    const dividends = Object.values(ev.dividends || {}).map(d => ({ date: tsToDate(d.date), amount: +(d.amount * scale).toFixed(6) })).sort((a, b) => a.date < b.date ? -1 : 1);
    const splits = Object.values(ev.splits || {}).map(s => ({ date: tsToDate(s.date), ratio: s.denominator ? s.numerator / s.denominator : 1, text: s.splitRatio || "" })).sort((a, b) => a.date < b.date ? -1 : 1);
    return { symbol, name: meta.shortName || meta.longName || symbol, ccy, market: mktOf(symbol), last: raw[raw.length - 1], dates, raw, adj, open, high, low, volume, dividends, splits, source: "yahoo", adjusted: true };
  },

  /* ---- Stooq:歷史價備援(CSV,拆股已調整、未含股息調整) ---- */
  stooqSymbol(symbol) {
    if (/\.HK$/i.test(symbol)) return symbol.replace(/\.HK$/i, ".hk").toLowerCase();
    if (/\.T$/i.test(symbol)) return symbol.replace(/\.T$/i, ".jp").toLowerCase();
    if (/^[A-Z.\-]+$/i.test(symbol) && !symbol.includes(".")) return symbol.toLowerCase() + ".us";
    return null; // 其他市場不支援
  },
  async stooqHistory(symbol) {
    const ss = providers.stooqSymbol(symbol);
    if (!ss) throw new Error("stooq_unsupported");
    const d2 = todayStr().replace(/-/g, "");
    const csv = await fetchAny([`https://stooq.com/q/d/l/?s=${encodeURIComponent(ss)}&d1=20201228&d2=${d2}&i=d`], true);
    const lines = csv.trim().split("\n");
    if (lines.length < 3 || !/^Date,/i.test(lines[0])) throw new Error("no_data");
    const dates = [], raw = [], open = [], high = [], low = [], volume = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(",");
      const px = parseFloat(c[4]);
      if (!c[0] || !isFinite(px)) continue;
      dates.push(c[0]); raw.push(px);
      open.push(isFinite(parseFloat(c[1])) ? parseFloat(c[1]) : null);
      high.push(isFinite(parseFloat(c[2])) ? parseFloat(c[2]) : null);
      low.push(isFinite(parseFloat(c[3])) ? parseFloat(c[3]) : null);
      volume.push(isFinite(parseInt(c[5])) ? parseInt(c[5]) : null);
    }
    if (!dates.length) throw new Error("no_data");
    const ccy = /\.hk$/.test(ss) ? "HKD" : /\.jp$/.test(ss) ? "JPY" : "USD";
    return { symbol, name: symbol, ccy, market: mktOf(symbol), last: raw[raw.length - 1], dates, raw, adj: raw.slice(), open, high, low, volume, dividends: [], splits: [], source: "stooq", adjusted: false };
  },

  /* ---- Yahoo:匯率 ---- */
  async yahooFx(ccy, fromTs) {
    const h = await providers.yahooHistory(ccy + "=X", fromTs);
    return { ccy, dates: h.dates, rates: h.raw.map(v => v == null ? null : v), source: "yahoo" };
  },

  /* ---- Frankfurter(ECB):匯率備援(不含 TWD) ---- */
  async frankfurterFx(ccy, fromDate) {
    const range = `${fromDate || "2020-12-28"}..`;
    const j = await fetchAny([
      `https://api.frankfurter.app/${range}?from=USD&to=${ccy}`,
      `https://api.frankfurter.dev/v1/${range}?base=USD&symbols=${ccy}`
    ]);
    const rates = j && j.rates;
    if (!rates) throw new Error("no_data");
    const dates = Object.keys(rates).sort();
    const out = { ccy, dates, rates: dates.map(d => rates[d][ccy]).map(v => v == null ? null : +(+v).toFixed(6)), source: "frankfurter" };
    if (!out.dates.length) throw new Error("no_data");
    return out;
  },

  /* ---- Yahoo:代碼搜尋 ---- */
  async yahooSearch(q) {
    const j = await fetchAny(YH(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0&enableFuzzyQuery=false`));
    const ccyOf = s => /\.HK$/i.test(s) ? "HKD" : /\.(SS|SZ)$/i.test(s) ? "CNY" : /\.T$/i.test(s) ? "JPY" : /\.TWO?$/i.test(s) ? "TWD" : /\.L$/i.test(s) ? "GBP" : "USD";
    return {
      results: (j.quotes || [])
        .filter(o => o.symbol && ["EQUITY", "ETF", "INDEX", "MUTUALFUND", "CURRENCY", "CRYPTOCURRENCY"].includes(o.quoteType))
        .slice(0, 8)
        .map(o => ({ s: o.symbol, n: o.shortname || o.longname || o.symbol, z: o.longname || o.shortname || o.symbol, m: mktOf(o.symbol), c: ccyOf(o.symbol), dyn: 1 }))
    };
  }
};

/* ====================== #5 通用 JSONPath 自訂數據源 ====================== */
/* 借鏡 Portfolio Performance 的 JSON Quote Feed:URL + 日期路徑 + 價格路徑 即可接入任意 API */
const CUSTOM_F = path.join(DATA, "custom_sources.json");
let CUSTOM = readJSON(CUSTOM_F, {}); // SYMBOL -> {url,datePath,pricePath,ccy,name}
function saveCustom() { writeJSON(CUSTOM_F, CUSTOM) }

/* JSONPath 子集:$ .key ['key'] ["key"] [N] [*] .*  */
function jsonPathTokens(pathStr) {
  let s = String(pathStr || "").trim();
  if (s[0] !== "$") throw new Error("path_must_start_with_$");
  s = s.slice(1);
  const t = [];
  const re = /^(?:\.([A-Za-z0-9_\- ()]+|\*)|\[(\d+)\]|\['([^']*)'\]|\["([^"]*)"\]|\[\*\])/;
  while (s.length) {
    const m = s.match(re);
    if (!m) throw new Error("bad_path_near:" + s.slice(0, 16));
    if (m[1] !== undefined) t.push(m[1] === "*" ? { wild: 1 } : { key: m[1] });
    else if (m[2] !== undefined) t.push({ idx: +m[2] });
    else if (m[3] !== undefined) t.push({ key: m[3] });
    else if (m[4] !== undefined) t.push({ key: m[4] });
    else t.push({ wild: 1 });
    s = s.slice(m[0].length);
  }
  return t;
}
function jsonPathEval(obj, pathStr) {
  let cur = [obj];
  for (const tk of jsonPathTokens(pathStr)) {
    const nxt = [];
    for (const n of cur) {
      if (n == null) continue;
      if (tk.wild) { if (Array.isArray(n)) nxt.push(...n); else if (typeof n === "object") nxt.push(...Object.values(n)) }
      else if (tk.idx !== undefined) { if (Array.isArray(n) && n[tk.idx] !== undefined) nxt.push(n[tk.idx]) }
      else if (typeof n === "object" && n[tk.key] !== undefined) nxt.push(n[tk.key]);
    }
    cur = nxt;
  }
  if (cur.length === 1 && Array.isArray(cur[0])) return cur[0];
  return cur;
}
/* 自動偵測日期格式(借鏡 PP):ISO / Unix 秒 / Unix 毫秒 / MM/DD/YYYY / 其他可解析格式 */
function normDate(v) {
  if (v == null) return null;
  if (typeof v === "number") {
    const ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
    return ms ? new Date(ms).toISOString().slice(0, 10) : null;
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{13}$/.test(s)) return new Date(+s).toISOString().slice(0, 10);
  if (/^\d{10}$/.test(s)) return new Date(+s * 1000).toISOString().slice(0, 10);
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) { const [a, b, y] = s.split("/"); return `${y}-${a}-${b}` }
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
/* 基本 SSRF 防護:自訂 URL 不得指向內網 */
function isSafeUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return false;
    const h = x.hostname.toLowerCase();
    if (h === "localhost" || h === "0.0.0.0" || h.startsWith("127.") || h.startsWith("10.") ||
        h.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.includes(":")) return false;
    return true;
  } catch (e) { return false }
}
/* §2.5 自訂源連續失敗監控:第 3 次起記錄 alerts 日誌並輸出報警 */
const CUSTOM_FAILS = {};
const ALERTS_F = path.join(DATA, "alerts.log");
function noteCustomFail(symbol, err) {
  const n = (CUSTOM_FAILS[symbol] = (CUSTOM_FAILS[symbol] || 0) + 1);
  if (n >= 3) {
    const line = `${new Date().toISOString()} ALERT custom-source ${symbol} failed ${n}x: ${err}
`;
    try { fs.appendFileSync(ALERTS_F, line) } catch (e) {}
    log("⚠️ ALERT custom-source", symbol, "failed", n + "x:", err);
  }
}
async function customHistory(symbol, cfg) {
  if (!isSafeUrl(cfg.url)) throw new Error("unsafe_url");
  const j = await fetchAny([cfg.url]);
  const dRaw = jsonPathEval(j, cfg.datePath);
  const pRaw = jsonPathEval(j, cfg.pricePath);
  if (!Array.isArray(dRaw) || !Array.isArray(pRaw)) throw new Error("path_not_array");
  const n = Math.min(dRaw.length, pRaw.length);
  const map = new Map();
  for (let i = 0; i < n; i++) {
    const d = normDate(dRaw[i]), p = parseFloat(pRaw[i]);
    if (d && isFinite(p)) map.set(d, +p.toFixed(6));
  }
  if (!map.size) throw new Error("no_rows");
  const dates = [...map.keys()].sort();
  const raw = dates.map(d => map.get(d));
  return { symbol, name: cfg.name || symbol, ccy: cfg.ccy || "USD", market: "CUSTOM", last: raw[raw.length - 1], dates, raw, adj: raw.slice(), open: [], high: [], low: [], volume: [], dividends: [], splits: [], source: "custom", adjusted: false };
}

/* ====================== #7 CoinGecko 加密貨幣 provider ====================== */
/* ====================== SEC EDGAR 13F:投資大師季度持倉 ======================
   公開資訊(美國政府資料,免費可引用)。限制:① 季末後最多 45 天才公布,故有延遲;
   ② 僅美股多頭,不含現金/債券/海外/做空。我們解析最近一期 13F-HR 的 information table。
   數據源需 User-Agent(SEC 規定),禮貌性快取 24 小時。 */
// 投資大師名單。tag:風格分組;warn:13F 模擬失真等級(high=多空/高周轉,13F 只揭露多頭,失真大)。
// 註:新增 4 位(citadel/point72/tiger/himalaya/ark)的 CIK 待實機(VPS)驗證,如抓不到請核對 SEC CIK。
const GURUS = [
  { id: "berkshire", name: "Berkshire Hathaway", who: "Warren Buffett", cik: "0001067983", tag: "value", warn: "low" },
  { id: "himalaya", name: "Himalaya Capital", who: "Li Lu", cik: "0001709323", tag: "value", warn: "low" },
  { id: "appaloosa", name: "Appaloosa", who: "David Tepper", cik: "0001656456", tag: "value", warn: "mid" },
  { id: "pershing", name: "Pershing Square", who: "Bill Ackman", cik: "0001336528", tag: "value", warn: "mid" },
  { id: "duquesne", name: "Duquesne Family Office", who: "Stanley Druckenmiller", cik: "0001536411", tag: "macro", warn: "mid" },
  { id: "scion", name: "Scion Asset Mgmt", who: "Michael Burry", cik: "0001649339", tag: "value", warn: "mid" },
  { id: "citadel", name: "Citadel Advisors", who: "Ken Griffin", cik: "0001423053", tag: "macro", warn: "high" },
  { id: "point72", name: "Point72", who: "Steven Cohen", cik: "0001603466", tag: "macro", warn: "high" },
  { id: "tiger", name: "Tiger Global", who: "Chase Coleman", cik: "0001167483", tag: "growth", warn: "high" },
  { id: "ark", name: "ARK Investment", who: "Cathie Wood", cik: "0001697748", tag: "growth", warn: "high" },
  { id: "bridgewater", name: "Bridgewater Associates", who: "Ray Dalio", cik: "0001350694", tag: "macro", warn: "mid" },
  { id: "thirdpoint", name: "Third Point", who: "Dan Loeb", cik: "0001040273", tag: "value", warn: "mid" },
  { id: "baupost", name: "Baupost Group", who: "Seth Klarman", cik: "0001061768", tag: "value", warn: "low" }
];
const SEC_UA = process.env.SEC_UA || "AlphaNexus portfolio-tracker contact@example.com";
async function secFetch(url, asText) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": SEC_UA, "Accept-Encoding": "gzip, deflate" }, signal: ctl.signal });
    if (!r.ok) throw new Error("sec_" + r.status);
    return asText ? await r.text() : await r.json();
  } finally { clearTimeout(tm) }
}
function parseInfoTable(xml) {
  // 解析 13F information table XML,逐個 <infoTable> 取 nameOfIssuer/cusip/value/sshPrnamt
  const rows = [];
  const re = /<(?:\w+:)?infoTable>([\s\S]*?)<\/(?:\w+:)?infoTable>/g;
  const pick = (block, tag) => {
    const m = block.match(new RegExp(`<(?:\\w+:)?${tag}>([^<]*)<`, "i"));
    return m ? m[1].trim() : "";
  };
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const name = pick(b, "nameOfIssuer");
    const cusip = pick(b, "cusip");
    const value = parseFloat(pick(b, "value").replace(/,/g, ""));
    const sh = parseFloat(pick(b, "sshPrnamt").replace(/,/g, ""));
    const cl = pick(b, "titleOfClass");
    if (name && isFinite(value)) rows.push({ name, cusip, value, shares: isFinite(sh) ? sh : null, cls: cl });
  }
  return rows;
}
/* 大師資料檔案存取(data/gurus/)。holdings=多季持倉,nav=每日淨值,index=名單與更新時間。 */
function guruPath(id, kind) { return path.join(GURU_DIR, id + "." + kind + ".json"); }
function guruRead(id, kind) {
  try { return JSON.parse(fs.readFileSync(guruPath(id, kind), "utf8")) } catch (e) { return null }
}
function guruWrite(id, kind, data) {
  try { fs.writeFileSync(guruPath(id, kind), JSON.stringify(data)); return true } catch (e) { return false }
}
function guruIndexRead() {
  try { return JSON.parse(fs.readFileSync(path.join(GURU_DIR, "index.json"), "utf8")) } catch (e) { return null }
}
function guruIndexWrite(data) {
  try { fs.writeFileSync(path.join(GURU_DIR, "index.json"), JSON.stringify(data)); return true } catch (e) { return false }
}
function collectGuruSymbols() {
  const syms = new Set();
  for (const g of GURUS) {
    try {
      const doc = guruRead(g.id, "holdings");
      if (doc && doc.quarters) for (const q of doc.quarters) for (const h of q.holdings) if (h.sym) syms.add(h.sym);
    } catch (e) {}
  }
  return [...syms];
}

/* 大師假想淨值計算(純函式,便於測試)。
   quarters: [{date:'YYYY-MM-DD', holdings:[{sym, pct}]}],按季排序(pct=該股市值占比,和約為1)。
   priceOf(sym, dateStr): 回傳該股某日收盤價,無則 null。
   dates: 要計算淨值的每日日期序列(升序,涵蓋首季到末日)。
   opts: {initial=1e6, negRate=0.03}。負現金按 negRate 年利率每日計息(正現金無回報)。
   演算法:
     · 首季首日:用 initial 按 pct 買入各股(股數=initial*pct/價);剩餘為現金。
     · 每逢新季度生效日:以當前總資產(持股市值+現金)按新 pct 重配置,
       資金差距 → 現金增減(允許負,代表調用外部資金)。
     · 每日:負現金計息(現金 -= |現金|*negRate/365);淨值 = Σ(股數×當日價) + 現金。
   回傳 [{date, nav}]。 */
function computeGuruNavSeries(quarters, priceOf, dates, opts) {
  opts = opts || {};
  const initial = opts.initial || 1e6, negRate = opts.negRate != null ? opts.negRate : 0.03;
  const minCoverage = opts.minCoverage != null ? opts.minCoverage : 0.5; // 逐期硬門檻
  if (!quarters.length || !dates.length) return { nav: [], coverages: [], minCov: 0, abandoned: true };
  // 逐期涵蓋率:該期「可定價持倉」的 pct 總和(以該季生效日的價格可得性判定)。
  // 涵蓋的持倉按比例正規化到 100% 後參與配置。
  const coverages = [];
  const normQuarters = quarters.map(q => {
    const covered = q.holdings.filter(h => h.sym && priceOf(h.sym, q.date) != null);
    const covPct = covered.reduce((s, h) => s + h.pct, 0);
    coverages.push({ date: q.date, coverage: +covPct.toFixed(4) });
    const norm = covPct > 1e-9 ? covered.map(h => ({ sym: h.sym, pct: h.pct / covPct })) : [];
    return { date: q.date, holdings: norm };
  });
  const minCov = coverages.reduce((m, c) => Math.min(m, c.coverage), 1);
  // 任何一期涵蓋率低於門檻 → 整位作廢(連續曲線只要一段嚴重失真即不可信)
  if (minCov < minCoverage) return { nav: [], coverages, minCov: +minCov.toFixed(4), abandoned: true };

  let qi = 0, shares = {}, cash = 0, started = false;
  const out = [];
  const priceAtOr = (sym, d) => { const p = priceOf(sym, d); return (p != null && isFinite(p) && p > 0) ? p : null; };
  const allocate = (q, d, totalAsset) => {
    const newShares = {}; let spent = 0;
    for (const h of q.holdings) {
      const px = priceAtOr(h.sym, d); if (!px) continue;
      const u = totalAsset * h.pct / px; newShares[h.sym] = u; spent += u * px;
    }
    shares = newShares; cash = totalAsset - spent;
  };
  for (const d of dates) {
    while (qi < normQuarters.length && normQuarters[qi].date <= d) {
      if (!started) { allocate(normQuarters[qi], d, initial); started = true; }
      else {
        const totalAsset = Object.keys(shares).reduce((s, sym) => {
          const px = priceAtOr(sym, d); return s + (px ? shares[sym] * px : 0);
        }, cash);
        allocate(normQuarters[qi], d, totalAsset);
      }
      qi++;
    }
    if (!started) continue;
    if (cash < 0) cash -= Math.abs(cash) * negRate / 365;
    let nav = cash;
    for (const sym in shares) { const px = priceAtOr(sym, d); if (px) nav += shares[sym] * px; }
    out.push({ date: d, nav: +nav.toFixed(2) });
  }
  return { nav: out, coverages, minCov: +minCov.toFixed(4), abandoned: false };
}

async function getGuru(id) {
  const guru = GURUS.find(g => g.id === id);
  if (!guru) throw new Error("unknown_guru");
  const key = "guru:" + id;
  const c = cacheGet(key, 24 * 3600e3);
  if (c) return c;
  // 1) 找最近一期 13F-HR
  const subs = await secFetch(`https://data.sec.gov/submissions/CIK${guru.cik}.json`);
  const recent = subs.filings && subs.filings.recent;
  if (!recent) throw new Error("no_filings");
  let idx = -1;
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] === "13F-HR") { idx = i; break }
  }
  if (idx < 0) throw new Error("no_13f");
  const accession = recent.accessionNumber[idx].replace(/-/g, "");
  const reportDate = recent.reportDate ? recent.reportDate[idx] : (recent.filingDate ? recent.filingDate[idx] : "");
  // 2) 取該 filing 目錄,找 information table XML
  const dir = `https://www.sec.gov/Archives/edgar/data/${parseInt(guru.cik, 10)}/${accession}`;
  const listing = await secFetch(dir + "/", true).catch(() => "");
  let xmlFile = null;
  const fm = [...listing.matchAll(/href="[^"]*?\/([^"\/]+\.xml)"/gi)].map(x => x[1]);
  // 優先選含 infoTable/form13f 的 xml,排除 primary_doc
  xmlFile = fm.find(f => /info|table|13f/i.test(f) && !/primary_doc/i.test(f)) || fm.find(f => !/primary_doc/i.test(f));
  if (!xmlFile) throw new Error("no_table");
  const xml = await secFetch(dir + "/" + xmlFile, true);
  let rows = parseInfoTable(xml);
  // 合併同一發行人(同名)持倉
  const merged = {};
  for (const r of rows) {
    const k = r.name + "|" + (r.cls || "");
    if (!merged[k]) merged[k] = { name: r.name, cusip: r.cusip, value: 0, shares: 0, cls: r.cls };
    merged[k].value += r.value;
    if (r.shares) merged[k].shares += r.shares;
  }
  rows = Object.values(merged).sort((a, b) => b.value - a.value);
  // SEC 13F value 欄位:2023 年後為「美元」,之前為「千美元」。以總額啟發式判斷單位。
  const total = rows.reduce((s, r) => s + r.value, 0);
  const topRaw = rows.slice(0, 10);
  const top = await Promise.all(topRaw.map(async r => ({
    name: r.name, sym: await cusipToTicker(r.cusip, r.name).catch(() => null),
    value: r.value, shares: r.shares, pct: total > 0 ? r.value / total : 0
  })));
  const out = {
    id, name: guru.name, who: guru.who, cik: guru.cik, reportDate,
    totalValue: total, holdings: rows.length, top,
    note: "僅美股多頭,不含現金/債券/海外/做空;季末後最多 45 天公布"
  };
  cacheSet(key, out);
  return out;
}

/* 抓某大師某一期 13F 的持倉(回 [{name,cusip,shares,value}] 與 reportDate)。
   accessionIdx:在 recent.form 中第幾個 13F-HR(0=最新)。供多季抓取。 */
/* CUSIP → ticker 自動解析(三層查找):
   ① 9碼快取(cusip_cache.json,自動累積)
   ② 6碼硬編碼對照表(CUSIP_TICKER,兜底)
   ③ OpenFIGI API(免費,自動查詢+快取)
   快取檔: data/cusip_cache.json */
const CUSIP_CACHE_PATH = (() => {
  const p = require("path");
  const dataDir = process.env.WL_DATA_DIR || p.join(process.cwd(), "data");
  return p.join(dataDir, "cusip_cache.json");
})();
let _cusipCache = null;
function cusipCacheLoad() {
  if (_cusipCache) return _cusipCache;
  try { _cusipCache = JSON.parse(require("fs").readFileSync(CUSIP_CACHE_PATH, "utf8")); }
  catch { _cusipCache = {}; }
  return _cusipCache;
}
function cusipCacheSave() {
  if (!_cusipCache) return;
  try { require("fs").writeFileSync(CUSIP_CACHE_PATH, JSON.stringify(_cusipCache, null, 2)); }
  catch { /* ignore write errors */ }
}
/* OpenFIGI rate limiter: max 20 req/min for free tier */
let _figiQueue = [], _figiLast = 0;
async function openFigiResolve(cusip9) {
  if (!cusip9 || cusip9.length < 6) return null;
  const cache = cusipCacheLoad();
  if (cache[cusip9]) return cache[cusip9];
  // Rate limit: wait if needed
  const now = Date.now();
  const wait = Math.max(0, 3100 - (now - _figiLast)); // ~20/min
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _figiLast = Date.now();
  try {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch("https://api.openfigi.com/v3/mapping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ idType: "ID_CUSIP", idValue: cusip9 }]),
      signal: ctl.signal
    });
    clearTimeout(tm);
    if (!r.ok) return null;
    const data = await r.json();
    if (data && data[0] && data[0].data && data[0].data[0]) {
      const ticker = data[0].data[0].ticker;
      if (ticker) {
        cache[cusip9] = ticker;
        cusipCacheSave();
        return ticker;
      }
    }
  } catch { /* timeout or network error */ }
  return null;
}
/* 由 CUSIP(9碼) + 名稱推 ticker。三層查找。 */
async function cusipToTicker(cusip, name) {
  if (!cusip) return null;
  const c9 = cusip.replace(/\s/g, "").toUpperCase();
  const c6 = c9.slice(0, 6);
  // ① 9碼快取
  const cache = cusipCacheLoad();
  if (cache[c9]) return cache[c9];
  // ② 6碼硬編碼表
  const t = CUSIP_TICKER[c6];
  if (t && t.trim()) return t.trim();
  // ③ OpenFIGI 自動查詢(非同步,僅美股/ETF CUSIP)
  if (/^[0-9]/.test(c9) && c9.length >= 9) {
    const resolved = await openFigiResolve(c9);
    if (resolved) return resolved;
  }
  return null;
}
const CUSIP_TICKER = {
  "037833": "AAPL", "594918": "MSFT", "023135": "AMZN", "02079K": "GOOGL", "30303M": "META",
  "67066G": "NVDA", "88160R": "TSLA", "084670": "BRK.B", "478160": "JNJ", "46625H": "JPM",
  "92826C": "V", "57636Q": "MA", "742718": "PG", "437076": "HD", "060505": "BAC",
  "92343V": "VZ", "166764": "CVX", "30231G": "XOM", "931142": "WMT", "458140": "INTC",
  "00206R": "T", "713448": "PEP", "191216": "KO", "532457": "LLY", "002824": "ABBV",
  "58933Y": "MRK", "717081": "PFE", "68389X": "ORCL", "11135F": "AVGO", "20030N": "CMCSA",
  "254687": "DIS", "17275R": "CSCO", "883556": "TMO", "01609W": "BABA", "874039": "TSM",
  "771049": "RACE", "152434": "CMG",  "76131D": "QSR","29786A": "ETSY", "G29183": "QGEN",
  "75513E": "RH", "302130": "EXPE", "00507V": " ", "045167": "ASML", "747525": "QCOM",
  "025816": "AXP", "172967": "C", "949746": "WFC", "38141G": "GS", "617446": "MS",
  "70450Y": "PYPL", "82509L": "SHOP", "G87110": "TLW", "98980L": "ZM", "01609B": "BABA",
  "459200": "IBM", "12508E": "CDAY", "55024U": "LULU", "278642": "EBAY", "278658": "ECL",
  "92556H": "VICI", "16119P": "CHTR", "G0750C": "ACN", "44890M": "HUBS", "983134": "WYNN",
  "126650": "CVS", "452308": " ", "00724F": "ADBE", "79466L": "CRM", "L8681T": "STLA",
  "78462F": "SPY", "464287": "IVV", "464286": "IWM", "464288": "AGG",
  "595112": "MU", "36828A": "GEV", "907818": "UNP", "036752": "ELV",
  "235851": "DHR", "007903": "AMD", "573874": "MRVL", "038222": "AMAT",
  "512807": "LRCX", "482480": "KLAC", "040413": "ANET", "651639": "NEM",
  "144285": "CRS", "538034": "LYV", "893641": "TDG", "655844": "NSC",
  "14040H": "COF", "95082P": "WCC", "879369": "TFX", "26969P": "EXP",
  "372460": "GPC", "438516": "HON", "37940X": "GPN", "285512": "EA",
  "76954A": "RIVN", "47215P": "JD", "69608A": "PLTR", "91324P": "UNH",
  "375558": "GILD", "21873S": "CRWV", "44812J": "HUT", "879433": "TDS",
  "81369Y": "XLK", "78463V": "GLD", "874039": "TSM", "76131D": "QSR"
};


async function fetchGuru13F(guru, recent, formIdx) {
  const accession = recent.accessionNumber[formIdx].replace(/-/g, "");
  const reportDate = recent.reportDate ? recent.reportDate[formIdx] : (recent.filingDate ? recent.filingDate[formIdx] : "");
  const dir = `https://www.sec.gov/Archives/edgar/data/${parseInt(guru.cik, 10)}/${accession}`;
  const listing = await secFetch(dir + "/", true).catch(() => "");
  const fm = [...listing.matchAll(/href="[^"]*?\/([^"\/]+\.xml)"/gi)].map(x => x[1]);
  const xmlFile = fm.find(f => /info|table|13f/i.test(f) && !/primary_doc/i.test(f)) || fm.find(f => !/primary_doc/i.test(f));
  if (!xmlFile) return null;
  const xml = await secFetch(dir + "/" + xmlFile, true);
  const rows = parseInfoTable(xml);
  const merged = {};
  for (const r of rows) {
    const k = (r.cusip || r.name) + "|" + (r.cls || "");
    if (!merged[k]) merged[k] = { name: r.name, cusip: r.cusip, value: 0, shares: 0 };
    merged[k].value += r.value; if (r.shares) merged[k].shares += r.shares;
  }
  const list = Object.values(merged).sort((a, b) => b.value - a.value);
  const total = list.reduce((s, r) => s + r.value, 0) || 1;
  // 存全部持倉(不限 top N),確保 diff 有完整股數數據;前端 top 表由 /api/guru 自行截取
  return { reportDate, holdings: await Promise.all(list.map(async r => ({ name: r.name, cusip: r.cusip, sym: await cusipToTicker(r.cusip, r.name), pct: r.value / total, shares: r.shares || 0 }))) };
}

/* 階段2:抓某大師過去 ~3 年(最多 quartersWanted 季)13F 持倉,存 holdings 檔。
   (需外網/SEC,沙箱無法執行;邏輯供 VPS 實機跑。) */
async function buildGuruHoldings(id, quartersWanted) {
  const guru = GURUS.find(g => g.id === id);
  if (!guru) throw new Error("unknown_guru");
  quartersWanted = quartersWanted || 12;
  const subs = await secFetch(`https://data.sec.gov/submissions/CIK${guru.cik}.json`);
  const recent = subs.filings && subs.filings.recent;
  if (!recent) throw new Error("no_filings");
  const idxs = [];
  for (let i = 0; i < recent.form.length && idxs.length < quartersWanted; i++) {
    if (recent.form[i] === "13F-HR") idxs.push(i);
  }
  const quarters = [];
  for (const fi of idxs) {
    const q = await fetchGuru13F(guru, recent, fi).catch(() => null);
    if (q && q.holdings.length) quarters.push({ date: q.reportDate, holdings: q.holdings });
  }
  quarters.sort((a, b) => a.date < b.date ? -1 : 1); // 升序
  const doc = { id, who: guru.who, name: guru.name, quarters, builtAt: Date.now() };
  guruWrite(id, "holdings", doc);
  return doc;
}

/* 階段2:用已存的 holdings + 各股每日股價,算每日 nav 並存檔。
   注意:13F 用 CUSIP,需對映到可抓價的 ticker。此處假設 holdings 已帶 sym(ticker);
   實機建檔時需先補 CUSIP→ticker 對映(待階段3處理或用 SEC ticker 對照表)。
   (需外網抓股價,沙箱無法執行。) */
async function buildGuruNav(id) {
  const doc = guruRead(id, "holdings");
  if (!doc || !doc.quarters || !doc.quarters.length) throw new Error("no_holdings");
  // 收集所有出現過的 ticker
  const syms = [...new Set(doc.quarters.flatMap(q => q.holdings.map(h => h.sym).filter(Boolean)))];
  // 抓各股歷史(每日收盤),建立 priceOf(sym,date)
  const priceMap = {};
  for (const s of syms) {
    try { const h = await smartHistory(s); priceMap[s] = {}; (h.dates || []).forEach((d, i) => priceMap[s][d] = h.raw[i]); }
    catch (e) { priceMap[s] = {}; }
  }
  const priceOf = (sym, d) => {
    if (!priceMap[sym]) return null;
    if (priceMap[sym][d] != null) return priceMap[sym][d];
    // 13F 季度末日常落在週末/假日,往前找最近交易日(最多 5 天)
    for (let i = 1; i <= 5; i++) {
      const prev = new Date(d + "T00:00:00Z");
      prev.setUTCDate(prev.getUTCDate() - i);
      const k = prev.toISOString().slice(0, 10);
      if (priceMap[sym][k] != null) return priceMap[sym][k];
    }
    return null;
  };
  // 日期序列:從首季到今天(用任一有資料股票的交易日)
  const allDates = new Set();
  for (const s of syms) for (const d in (priceMap[s] || {})) allDates.add(d);
  const start = doc.quarters[0].date;
  const dates = [...allDates].filter(d => d >= start).sort();
  const quartersWithSym = doc.quarters.map(q => ({ date: q.date, holdings: q.holdings.filter(h => h.sym).map(h => ({ sym: h.sym, pct: h.pct })) }));
  const res = computeGuruNavSeries(quartersWithSym, priceOf, dates, { initial: 1e6, negRate: 0.03, minCoverage: 0.5 });
  const out = {
    id, who: doc.who, name: doc.name,
    nav: res.nav, coverages: res.coverages, minCoverage: res.minCov, abandoned: res.abandoned,
    builtAt: Date.now(),
    note: "13F 季度模擬,僅美股多頭、45天延遲、不含現金/做空/衍生品/非美股,僅供參考"
  };
  guruWrite(id, "nav", out);
  return out;
}

/* 階段3:建檔編排——抓所有大師多季持倉→算 nav→寫 index。供部署後手動初始化與每日排程。
   (需外網,沙箱無法執行;在 VPS 上跑:node server.js --build-gurus) */
async function buildAllGurus(opts) {
  opts = opts || {};
  const ids = opts.ids || GURUS.map(g => g.id);
  const results = [];
  for (const id of ids) {
    try {
      await buildGuruHoldings(id, opts.quarters || 12);
      const nav = await buildGuruNav(id);
      results.push({ id, ok: true, minCoverage: nav.minCoverage, abandoned: nav.abandoned, points: nav.nav.length });
      log(`guru built: ${id} cov=${nav.minCoverage} abandoned=${nav.abandoned} pts=${nav.nav.length}`);
    } catch (e) {
      results.push({ id, ok: false, error: String(e.message || e) });
      log(`guru build failed: ${id} — ${e.message || e}`);
    }
  }
  guruIndexWrite({ updatedAt: Date.now(), results });
  return results;
}

async function coingeckoHistory(symbol) {
  const m = String(symbol).match(/^([A-Z0-9]{2,10})-USD$/i);
  if (!m) throw new Error("cg_unsupported");
  const q = m[1].toUpperCase();
  const sj = await fetchAny([`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`]);
  const coin = (sj.coins || []).find(c => c.symbol && c.symbol.toUpperCase() === q) || (sj.coins || [])[0];
  if (!coin) throw new Error("cg_not_found");
  const now = Math.floor(Date.now() / 1000);
  const cj = await fetchAny([`https://api.coingecko.com/api/v3/coins/${coin.id}/market_chart/range?vs_currency=usd&from=${EPOCH_FROM}&to=${now}`]);
  const prices = cj.prices || [];
  if (!prices.length) throw new Error("no_data");
  const map = new Map();
  for (const [ms, p] of prices) map.set(new Date(ms).toISOString().slice(0, 10), +(+p).toFixed(6));
  const dates = [...map.keys()].sort();
  const raw = dates.map(d => map.get(d));
  return { symbol: symbol.toUpperCase(), name: coin.name || symbol, ccy: "USD", market: "CRYPTO", last: raw[raw.length - 1], dates, raw, adj: raw.slice(), open: [], high: [], low: [], volume: [], dividends: [], splits: [], source: "coingecko", adjusted: true };
}

/* 同鍵並發合併:1000 人同時請求同一代碼,僅對外發出 1 次上游請求 */
const INFLIGHT = new Map();
function coalesce(key, fn) {
  if (INFLIGHT.has(key)) return INFLIGHT.get(key);
  const p = fn().finally(() => INFLIGHT.delete(key));
  INFLIGHT.set(key, p);
  return p;
}

/* ====================== 智慧歷史價:持久庫 + 增量 + 備援鏈 ====================== */
function smartHistory(symbol) { return coalesce("h:" + symbol, () => smartHistoryInner(symbol)) }
async function smartHistoryInner(symbol) {
  const store = loadStore("hist", symbol);
  if (store && Date.now() - store.fetchedAt < FRESH_MS) return { ...store, stale: false };

  // 0) 自訂數據源優先(用戶以 JSONPath 指定的任意 API)
  const cs = CUSTOM[symbol];
  if (cs) {
    try {
      const doc = await customHistory(symbol, cs);
      CUSTOM_FAILS[symbol] = 0;
      return { ...saveStore("hist", symbol, doc), stale: false };
    } catch (e) {
      noteCustomFail(symbol, String(e.message || e));
      if (store) return { ...store, stale: true };
      throw e;
    }
  }

  // 1) 主源 Yahoo:增量(庫存為 Yahoo 時)或全量
  try {
    let doc;
    if (store && store.source === "yahoo" && store.dates.length) {
      const lastTs = dateToTs(store.dates[store.dates.length - 1]);
      const inc = await providers.yahooHistory(symbol, lastTs - 14 * 86400); // 兩週重疊修復窗
      doc = hasNewEvents(store, inc)
        ? await providers.yahooHistory(symbol, EPOCH_FROM)   // 新事件 → 調整價回溯變動 → 全量重抓
        : mergeSeries(store, inc);
    } else {
      doc = await providers.yahooHistory(symbol, EPOCH_FROM);
    }
    return { ...saveStore("hist", symbol, doc), stale: false };
  } catch (e) { log("yahoo hist fail", symbol, String(e.message || e)) }

  // 2) 庫存兜底:寧可用過期的「含調整價」庫存,也不切換到不含股息調整的備源(口徑一致)
  if (store) return { ...store, stale: true };

  // 3) 備源:加密貨幣樣式(XXX-USD)→ CoinGecko;其餘 → Stooq
  if (/^[A-Z0-9]{2,10}-USD$/i.test(symbol)) {
    try { return { ...saveStore("hist", symbol, await coingeckoHistory(symbol)), stale: false } }
    catch (e) { log("coingecko fail", symbol, String(e.message || e)) }
  }
  const st = await providers.stooqHistory(symbol); // 失敗則拋出,由路由回 502
  return { ...saveStore("hist", symbol, st), stale: false };
}

/* ====================== 智慧匯率:同上 ====================== */
function smartFx(ccy) { return coalesce("fx:" + ccy, () => smartFxInner(ccy)) }
async function smartFxInner(ccy) {
  const store = loadStore("fx", ccy);
  if (store && Date.now() - store.fetchedAt < FRESH_MS) return { ...store, stale: false };
  try {
    let doc;
    if (store && store.source === "yahoo" && store.dates.length) {
      const lastTs = dateToTs(store.dates[store.dates.length - 1]);
      const inc = await providers.yahooFx(ccy, lastTs - 14 * 86400);
      doc = mergeSeries({ ...store, raw: store.rates, adj: store.rates }, { ...inc, raw: inc.rates, adj: inc.rates });
      doc = { ccy, dates: doc.dates, rates: doc.raw, source: "yahoo" };
    } else {
      const full = await providers.yahooFx(ccy, EPOCH_FROM);
      doc = { ccy, dates: full.dates, rates: full.rates, source: "yahoo" };
    }
    return { ...saveStore("fx", ccy, doc), stale: false };
  } catch (e) { log("yahoo fx fail", ccy, String(e.message || e)) }
  if (store) return { ...store, stale: true };
  const fr = await providers.frankfurterFx(ccy); // ECB 備援(TWD 不支援會拋出)
  return { ...saveStore("fx", ccy, fr), stale: false };
}

/* ====================== 搜尋與新聞 ====================== */
async function searchSymbols(q) {
  const key = "search:" + q.toLowerCase();
  const c = cacheGet(key, TTL.search);
  if (c) return c;
  const out = await providers.yahooSearch(q);
  cacheSet(key, out);
  return out;
}
/* ====================== 新聞數據層(可插拔) ======================
   預設:Yahoo Finance 非公開接口聚合(僅標題+來源+連結,不轉載內文;個人/示範用)。
   設定環境變數即切換為「有授權的正規新聞 API」(商業上線建議),架構不變:
     NEWS_PROVIDER = newsapi | marketaux        (擇一)
     NEWS_API_KEY  = <你的金鑰>
   兩者皆只取標題/來源/連結並導流原站,符合其服務條款的聚合用途。 */
const NEWS_PROVIDER = (process.env.NEWS_PROVIDER || "").toLowerCase();
const NEWS_API_KEY = process.env.NEWS_API_KEY || "";
const NEWS_ENABLED_EXT = !!(NEWS_PROVIDER && NEWS_API_KEY);
// NEWS_PROVIDER=rss → 使用 Google News RSS(中文市場可取港/台/A 股新聞;個人/非商業用途,保留出處)
const USE_RSS = NEWS_PROVIDER === "rss";

const newsProviders = {
  /* NewsAPI.org:everything 端點,依關鍵詞查詢,只取標題/來源/URL */
  async newsapi(query, n) {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&language=en&pageSize=${n}&apiKey=${NEWS_API_KEY}`;
    const j = await fetchAny([url]);
    const now = Date.now() / 1000;
    return (j.articles || []).map(a => ({
      title: a.title, src: (a.source && a.source.name) || "", url: a.url,
      agoH: Math.max(0.1, (now - (a.publishedAt ? Date.parse(a.publishedAt) / 1000 : now)) / 3600)
    })).filter(x => x.title && x.url);
  },
  /* Marketaux:金融新聞,支援 symbols 參數,只取標題/來源/URL */
  async marketaux(query, n, symbol) {
    const base = "https://api.marketaux.com/v1/news/all";
    const url = symbol
      ? `${base}?symbols=${encodeURIComponent(symbol)}&filter_entities=true&language=en&limit=${n}&api_token=${NEWS_API_KEY}`
      : `${base}?search=${encodeURIComponent(query)}&language=en&limit=${n}&api_token=${NEWS_API_KEY}`;
    const j = await fetchAny([url]);
    const now = Date.now() / 1000;
    return (j.data || []).map(a => ({
      title: a.title, src: a.source || "", url: a.url,
      agoH: Math.max(0.1, (now - (a.published_at ? Date.parse(a.published_at) / 1000 : now)) / 3600)
    })).filter(x => x.title && x.url);
  }
};

/* 解析 RSS/Atom 的 item(只取標題/連結/來源/時間,不取內文,符合著作權與 RSS 聚合用途) */
function parseRssItems(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  const pick = (b, tag) => {
    const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    if (!m) return "";
    return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "").trim();
  };
  for (const b of blocks) {
    let title = pick(b, "title");
    const link = pick(b, "link");
    const pub = pick(b, "pubDate");
    let src = pick(b, "source");
    // Google News 標題常為「標題 - 來源」:拆出來源(若無 source 標籤)並一律從標題移除尾綴
    const m = title.match(/^(.*) - ([^-]+)$/);
    if (m) { if (!src) src = m[2].trim(); title = m[1].trim(); }
    if (title && link) items.push({ title, url: link, src, pub });
  }
  return items;
}

/* Google News RSS:公開、媒體聚合性質,支援中文關鍵字 + 地區/語言。
   個人/非商業用途使用,僅取標題+來源+連結並導流原站,保留出處。 */
async function googleNewsRss(query, region) {
  // region: 'HK'(港,繁中)/ 'TW'(台,繁中)/ 'CN'(陸,簡中)/ 'JP'(日,日文)/ 'US'(英文)
  const cfg = {
    HK: "hl=zh-HK&gl=HK&ceid=HK:zh-Hant",
    TW: "hl=zh-TW&gl=TW&ceid=TW:zh-Hant",
    CN: "hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
    JP: "hl=ja&gl=JP&ceid=JP:ja",
    US: "hl=en-US&gl=US&ceid=US:en"
  }[region] || "hl=en-US&gl=US&ceid=US:en";
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${cfg}`;
  const xml = await fetchAny([url], true);
  const now = Date.now();
  return parseRssItems(xml).map(it => ({
    title: it.title, src: it.src || "Google News", url: it.url,
    agoH: Math.max(0.1, (now - (it.pub ? Date.parse(it.pub) : now)) / 3600000)
  })).filter(x => x.title && x.url);
}

/* 把代碼解析為查詢詞 + 對應地區(供 RSS) */
function newsQueryInfo(sym) {
  const store = loadStore("hist", sym);
  const name = store && store.name && store.name !== sym ? store.name : null;
  const mkt = mktOf(sym);
  const bare = sym.replace(/\.(HK|SS|SZ|T|TWO?|L)$/i, "");
  // region 決定 RSS 的語言/地區;US = 走 Yahoo 英文(或授權 API)
  const region = mkt === "HK" ? "HK" : mkt === "TW" ? "TW" : mkt === "CN" ? "CN" : mkt === "JP" ? "JP" : "US";
  // 查詢詞策略:
  //  · 中文市場(港/台/A)+ 日股:優先公司名稱,再去後綴代碼(英文/在地索引對 .HK/.T 等後綴差)
  //  · 美股:代碼索引良好,用代碼 + 名稱
  const queries = (region === "US" && mkt === "US")
    ? [sym, name].filter(Boolean)
    : [name, bare, sym].filter(Boolean);
  return { region, name, bare, queries: [...new Set(queries)].slice(0, 2) };
}

/* 單支股票的新聞(按單支快取 + 同鍵合併;與用戶數無關,全站每支每 TTL 週期最多抓一次) */
function newsForSymbol(sym) {
  return coalesce("news1:" + sym, async () => {
    const info = newsQueryInfo(sym);
    // 按市場自動選來源:中文市場(港/台/A 股)優先用 Google News 中文 RSS,
    // 不需設任何環境變數;美股維持原本來源(授權 API 或 Yahoo)。
    const useLocalRss = info.region !== "US"; // 中文市場(港/台/A)+ 日股 → Google News 在地語言
    const srcTag = NEWS_ENABLED_EXT ? NEWS_PROVIDER : (useLocalRss || USE_RSS) ? "rss" : "yh";
    const ck = "news1:" + srcTag + ":" + sym;
    const cached = cacheGet(ck, TTL.news);
    if (cached) return cached;
    let got = [];
    try {
      if (NEWS_ENABLED_EXT) {
        // 已設定授權 API:美股用之;中文市場仍優先 Google News(授權 API 對港股中文新聞通常也弱)
        if (useLocalRss) { for (const q of info.queries) { got = await googleNewsRss(q, info.region); if (got.length) break; } }
        if (!got.length) got = await newsProviders[NEWS_PROVIDER](info.queries[0] || sym, 4, sym);
      } else if (useLocalRss || USE_RSS) {
        for (const q of info.queries) { got = await googleNewsRss(q, info.region); if (got.length) break; }
      } else {
        const nowS = Date.now() / 1000;
        for (const q of info.queries) {
          const j = await fetchAny(YH(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=4`));
          got = (j.news || []).map(n => ({ title: n.title, src: n.publisher || "", url: n.link || "", agoH: Math.max(0.1, (nowS - (n.providerPublishTime || nowS)) / 3600) })).filter(n => n.title && n.url);
          if (got.length) break;
        }
      }
    } catch (e) {}
    got = got.map(x => ({ ...x, sym })).slice(0, 6);
    if (got.length) cacheSet(ck, got);
    return got;
  });
}

/* 熱門財經(全站共用一份快取,與用戶無關) */
function hotNews() {
  return coalesce("newsHot", async () => {
    const ck = "newsHot:" + (NEWS_ENABLED_EXT ? NEWS_PROVIDER : USE_RSS ? "rss" : "yh");
    const cached = cacheGet(ck, TTL.news);
    if (cached) return cached;
    let hot = [];
    try {
      if (NEWS_ENABLED_EXT) hot = (await newsProviders[NEWS_PROVIDER]("stock market", 8, null)).map(x => ({ ...x, sym: null }));
      else if (USE_RSS) hot = (await googleNewsRss("財經 股市", "HK")).map(x => ({ ...x, sym: null }));
      else {
        const nowS = Date.now() / 1000;
        for (const q of ["stock market", "federal reserve"]) {
          const j = await fetchAny(YH(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=6`));
          hot.push(...(j.news || []).map(n => ({ title: n.title, src: n.publisher || "", url: n.link || "", agoH: Math.max(0.1, (nowS - (n.providerPublishTime || nowS)) / 3600), sym: null })).filter(n => n.title && n.url));
        }
      }
    } catch (e) {}
    hot = hot.slice(0, 20);
    if (hot.length) cacheSet(ck, hot);
    return hot;
  });
}

async function getNews(symbols) {
  const syms = symbols.slice(0, 8);
  // 按單支股票各自取(各自快取/合併),再彙整 —— 不再按「整組持倉」快取
  const results = await Promise.all(syms.map(s => newsForSymbol(s).catch(() => [])));
  const hot = await hotNews().catch(() => []);
  const seen = new Set();
  const dedupe = arr => arr.filter(n => !seen.has(n.url) && seen.add(n.url)).sort((a, b) => a.agoH - b.agoH);
  return { mine: dedupe([].concat(...results)).slice(0, 30), hot: dedupe(hot).slice(0, 20) };
}

/* ====================== 郵箱驗證(零依賴 SMTP,465 隱式 TLS) ======================
   設定環境變數即啟用:SMTP_HOST / SMTP_PORT(預設465) / SMTP_USER / SMTP_PASS / SMTP_FROM
   未設定時退回「免驗證直接註冊」模式(自架個人用)。 */
const SMTP = {
  host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 465),
  user: process.env.SMTP_USER, pass: process.env.SMTP_PASS,
  from: process.env.SMTP_FROM || process.env.SMTP_USER
};
const MAIL_ENABLED = !!(SMTP.host && SMTP.user && SMTP.pass);
const mailer = {
  send({ to, subject, text }) {
    return new Promise((resolve, reject) => {
      const tlsMod = require("tls");
      const sock = tlsMod.connect({ host: SMTP.host, port: SMTP.port, servername: SMTP.host });
      const tm = setTimeout(() => { sock.destroy(); reject(new Error("smtp_timeout")) }, 15000);
      let buf = "", step = 0;
      const b64 = s => Buffer.from(s).toString("base64");
      const msg = [
        `From: AlphaNexus <${SMTP.from}>`, `To: <${to}>`,
        `Subject: =?UTF-8?B?${b64(subject)}?=`,
        `MIME-Version: 1.0`, `Content-Type: text/plain; charset=utf-8`, ``,
        text, ``
      ].join("\r\n");
      const steps = [
        { expect: 220, cmd: `EHLO alphanexus` },
        { expect: 250, cmd: `AUTH LOGIN` },
        { expect: 334, cmd: b64(SMTP.user) },
        { expect: 334, cmd: b64(SMTP.pass) },
        { expect: 235, cmd: `MAIL FROM:<${SMTP.from}>` },
        { expect: 250, cmd: `RCPT TO:<${to}>` },
        { expect: 250, cmd: `DATA` },
        { expect: 354, cmd: msg + "\r\n." },
        { expect: 250, cmd: `QUIT`, done: true }
      ];
      sock.on("data", d => {
        buf += d.toString();
        // 取最後一行完整回應(處理 250-xxx 多行)
        const lines = buf.split("\r\n").filter(Boolean);
        const lastLine = lines[lines.length - 1] || "";
        if (!/^\d{3} /.test(lastLine)) return; // 等待結尾行(代碼後接空格)
        const code = +lastLine.slice(0, 3);
        buf = "";
        const st = steps[step];
        if (!st) return;
        if (code !== st.expect) { clearTimeout(tm); sock.destroy(); return reject(new Error("smtp_" + code)) }
        sock.write(st.cmd + "\r\n");
        if (st.done) { clearTimeout(tm); sock.end(); return resolve(true) }
        step++;
      });
      sock.on("error", e => { clearTimeout(tm); reject(e) });
    });
  }
};
/* ====================== 儲存層抽象(Store) ======================
   所有「用戶帳號 / 待驗證註冊 / 投資組合」的持久化都經過這個介面。
   目前後端為 JSON 檔(行為與先前完全一致)。將來用戶量大時,只需把這一層
   內部換成 SQLite(Node 22+ 內建 node:sqlite),其餘程式碼與 API 完全不動。 */
function createJsonStore() {
  const USERS_F = path.join(DATA, "users.json");
  const PENDING_F = path.join(DATA, "pending.json");
  let USERS = readJSON(USERS_F, {});
  let PENDING = readJSON(PENDING_F, {});
  const saveUsers = () => writeJSON(USERS_F, USERS);
  const savePending = () => writeJSON(PENDING_F, PENDING);
  return {
    getByEmail: (email) => USERS[email] || null,
    exists: (email) => !!USERS[email],
    getByToken: (token) => {
      for (const email in USERS) { const u = USERS[email]; if (u.tokens && u.tokens.includes(token)) return { email, u, token } }
      return null;
    },
    put: (email, rec) => { USERS[email] = rec; saveUsers() },
    save: () => saveUsers(),
    del: (email) => { delete USERS[email]; saveUsers() },
    pGet: (email) => PENDING[email] || null,
    pPut: (email, rec) => { PENDING[email] = rec; savePending() },
    pDel: (email) => { if (PENDING[email]) { delete PENDING[email]; savePending() } },
    pfGet: (uid) => readJSON(path.join(PORT_DIR, uid + ".json"), { txns: [], settings: null, updatedAt: 0 }),
    pfPut: (uid, doc) => writeJSON(path.join(PORT_DIR, uid + ".json"), doc),
    pfDel: (uid) => { try { const f = path.join(PORT_DIR, uid + ".json"); if (fs.existsSync(f)) fs.unlinkSync(f) } catch (e) {} },
    // 掃描所有組合的交易(供夜間預抓收集代碼)
    pfAllTxns: function* () {
      let files = []; try { files = fs.readdirSync(PORT_DIR) } catch (e) {}
      for (const f of files) { const d = readJSON(path.join(PORT_DIR, f), {}); for (const t of (d.txns || [])) yield t }
    },
    _raw: () => ({ USERS, PENDING })
  };
}
const Store = createJsonStore();

const genCode = () => String(crypto.randomInt(100000, 1000000));
async function sendVerifyCode(email, code) {
  await mailer.send({
    to: email,
    subject: "AlphaNexus 註冊驗證碼 / Verification Code",
    text: `您的 AlphaNexus 註冊驗證碼為:${code}\n15 分鐘內有效。若非本人操作請忽略本郵件。\n\nYour AlphaNexus verification code is: ${code}\nIt expires in 15 minutes.`
  });
}

/* ---------------------- 帳號系統 ---------------------- */
function hashPwd(pwd, salt) { return crypto.scryptSync(pwd, salt, 32).toString("hex") }
function pubUser(u, email) { return { name: u.name, email, avatar: u.avatar || "🙂" } }
function newToken(u) { const t = crypto.randomBytes(24).toString("hex"); u.tokens = (u.tokens || []).slice(-9); u.tokens.push(t); return t }
function userByToken(req) {
  const h = req.headers["authorization"] || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!t) return null;
  return Store.getByToken(t);
}

/* ---------------------- HTTP 工具 ---------------------- */
const zlib = require("zlib");
function send(req, res, code, obj) {
  let body = Buffer.from(JSON.stringify(obj));
  const origin = req.headers["origin"] || "";
  const corsOk = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": corsOk ? (origin || "*") : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Credentials": "true",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains"
  };
  // 流量優化:>1KB 的 JSON 以 gzip 壓縮(歷史序列可省 75–85% 出網流量)
  if (body.length > 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    body = zlib.gzipSync(body); headers["Content-Encoding"] = "gzip";
  }
  headers["Content-Length"] = body.length;
  res.writeHead(code, headers);
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "", n = 0;
    req.on("data", c => { n += c.length; if (n > 2e6) { reject(new Error("too_large")); req.destroy() } else buf += c });
    req.on("end", () => { try { resolve(buf ? JSON.parse(buf) : {}) } catch (e) { reject(new Error("bad_json")) } });
    req.on("error", reject);
  });
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end("forbidden") }
  fs.readFile(file, (err, buf0) => {
    let buf = buf0;
    if (err) {
      if (!p.startsWith("/api")) return fs.readFile(path.join(PUB, "index.html"), (e2, b2) => {
        if (e2) { res.writeHead(404); return res.end("not found") }
        res.writeHead(200, { "Content-Type": MIME[".html"] }); res.end(b2);
      });
      res.writeHead(404); return res.end("not found");
    }
    const mime = MIME[path.extname(file)] || "application/octet-stream";
    const headers = { "Content-Type": mime, "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" };
    // HTML 檔案不快取（確保更新後瀏覽器立即載入新版本）
    if (mime.startsWith("text/html")) headers["Cache-Control"] = "no-cache";
    if (/^(text\/|application\/json|image\/svg)/.test(mime) && buf.length > 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
      buf = zlib.gzipSync(buf); headers["Content-Encoding"] = "gzip";
    }
    headers["Content-Length"] = buf.length;
    res.writeHead(200, headers);
    res.end(buf);
  });
}

/* ---------------------- 速率限制 ---------------------- */
const RATE = new Map();
function rateOk(ip) {
  const now = Date.now();
  const r = RATE.get(ip) || { at: now, n: 0 };
  if (now - r.at > 60e3) { r.at = now; r.n = 0 }
  r.n++; RATE.set(ip, r);
  return r.n <= 240;
}
/* 登入防暴力破解:每 email 每分鐘最多 5 次 */
const LOGIN_RATE = new Map();
function loginRateOk(email) {
  const now = Date.now();
  const r = LOGIN_RATE.get(email) || { at: now, n: 0 };
  if (now - r.at > 60e3) { r.at = now; r.n = 0 }
  r.n++; LOGIN_RATE.set(email, r);
  return r.n <= 5;
}

/* ---------------------- 路由 ---------------------- */
const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || "?";
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  if (req.method === "OPTIONS") return send(req, res, 204, {});
  if (!p.startsWith("/api")) return serveStatic(req, res, req.url);
  if (!rateOk(ip)) return send(req, res, 429, { error: "rate_limited" });
  try {
    if (p === "/api/ping") return send(req, res, 200, { ok: true, t: Date.now() });

    /* ---- 市場數據 ---- */
    if (p === "/api/search") {
      const q = (u.searchParams.get("q") || "").trim();
      if (!q) return send(req, res, 200, { results: [] });
      try { return send(req, res, 200, await searchSymbols(q)) }
      catch (e) { return send(req, res, 502, { error: "no_data" }) }
    }
    if (p === "/api/history") {
      const sym = (u.searchParams.get("symbol") || "").trim();
      if (!sym) return send(req, res, 400, { error: "missing_symbol" });
      try { return send(req, res, 200, await smartHistory(sym)) }
      catch (e) { return send(req, res, 502, { error: "no_data", detail: String(e.message || e) }) }
    }
    if (p === "/api/fx") {
      const ccys = (u.searchParams.get("ccys") || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 12);
      const out = {};
      await Promise.all(ccys.map(async c => { try { out[c] = await smartFx(c) } catch (e) {} }));
      return send(req, res, 200, out);
    }
    if (p === "/api/gurus") {
      // 帶上已建檔的 nav 摘要(最低涵蓋率、是否作廢、最新淨值點),供前端列出可選大師
      const list = GURUS.map(g => {
        const nav = guruRead(g.id, "nav");
        const has = nav && !nav.abandoned && nav.nav && nav.nav.length;
        return {
          id: g.id, name: g.name, who: g.who, tag: g.tag, warn: g.warn,
          available: !!has,
          minCoverage: nav ? nav.minCoverage : null,
          abandoned: nav ? !!nav.abandoned : null,
          builtAt: nav ? nav.builtAt : null
        };
      });
      return send(req, res, 200, { gurus: list });
    }
    if (p === "/api/guru-nav") {
      const id = (u.searchParams.get("id") || "").trim();
      const nav = guruRead(id, "nav");
      if (!nav) return send(req, res, 404, { error: "not_built", hint: "需先在伺服器執行建檔(buildAllGurus)" });
      if (nav.abandoned) return send(req, res, 200, { id, abandoned: true, minCoverage: nav.minCoverage, nav: [] });
      return send(req, res, 200, { id, who: nav.who, name: nav.name, minCoverage: nav.minCoverage, nav: nav.nav, note: nav.note });
    }
    if (p === "/api/guru") {
      const id = (u.searchParams.get("id") || "").trim();
      try { return send(req, res, 200, await getGuru(id)) }
      catch (e) { return send(req, res, 502, { error: "guru_failed", detail: String(e.message || e) }) }
    }
    if (p === "/api/guru-diff") {
      const id = (u.searchParams.get("id") || "").trim();
      const n = Math.min(Math.max(parseInt(u.searchParams.get("quarters") || "3", 10) || 3, 2), 8);
      const doc = guruRead(id, "holdings");
      if (!doc || !doc.quarters || !doc.quarters.length) return send(req, res, 404, { error: "no_holdings" });
      const qs = doc.quarters.slice(-n); // 最近 n 季(已升序)
      // 每季完整持倉(供前端計算金額/股數變化)
      const qHoldings = qs.map(q => q.holdings.map(h => ({ name: h.name, sym: h.sym || null, pct: h.pct, shares: h.shares || 0 })));
      const diffs = [];
      for (let i = 1; i < qs.length; i++) {
        const prev = qs[i - 1], cur = qs[i];
        const prevMap = {}, curMap = {};
        for (const h of prev.holdings) { const k = h.sym || h.name; prevMap[k] = { pct: h.pct, name: h.name }; }
        for (const h of cur.holdings) { const k = h.sym || h.name; curMap[k] = { pct: h.pct, name: h.name }; }
        const allKeys = [...new Set([...Object.keys(prevMap), ...Object.keys(curMap)])];
        const changes = [];
        for (const k of allKeys) {
          const p0 = prevMap[k]?.pct || 0, p1 = curMap[k]?.pct || 0;
          const delta = p1 - p0;
          if (Math.abs(delta) < 0.001) continue;
          let type;
          if (p0 === 0) type = "new";
          else if (p1 === 0) type = "closed";
          else if (delta > 0) type = "increased";
          else type = "decreased";
          const name = curMap[k]?.name || prevMap[k]?.name || k;
          changes.push({ sym: k, name, pct: p1, delta: +delta.toFixed(4), type });
        }
        changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
        diffs.push({ from: prev.date, to: cur.date, changes });
      }
      return send(req, res, 200, { id, who: doc.who, name: doc.name, quarters: qs.map(q => q.date), qHoldings, diffs });
    }
    if (p === "/api/news") {
      const syms = (u.searchParams.get("symbols") || "").split(",").map(s => s.trim()).filter(Boolean);
      try { return send(req, res, 200, await getNews(syms)) }
      catch (e) { return send(req, res, 200, { mine: [], hot: [] }) }
    }

    /* ---- #5 自訂數據源管理(需登入) ---- */
    if (p === "/api/custom-sources") {
      const a = userByToken(req);
      if (!a) return send(req, res, 401, { error: "unauthorized" });
      if (req.method === "POST") {
        const b = await readBody(req);
        const sym = String(b.symbol || "").trim().toUpperCase();
        if (!/^[A-Z0-9._\-]{1,24}$/.test(sym)) return send(req, res, 400, { error: "bad_symbol" });
        if (!isSafeUrl(String(b.url || ""))) return send(req, res, 400, { error: "bad_url" });
        try { jsonPathTokens(String(b.datePath || "")); jsonPathTokens(String(b.pricePath || "")) }
        catch (e) { return send(req, res, 400, { error: "bad_path", detail: String(e.message || e) }) }
        CUSTOM[sym] = { url: String(b.url), datePath: String(b.datePath), pricePath: String(b.pricePath), ccy: String(b.ccy || "USD").toUpperCase().slice(0, 5), name: String(b.name || sym).slice(0, 60) };
        saveCustom();
        try { fs.unlinkSync(storePath("hist", sym)) } catch (e) {} // 清庫存,下次請求即用新設定重抓
        return send(req, res, 200, { ok: true, symbol: sym });
      }
      return send(req, res, 200, { sources: Object.entries(CUSTOM).map(([s, c]) => ({ symbol: s, ...c })) });
    }
    if (p === "/api/custom-sources/delete" && req.method === "POST") {
      const a = userByToken(req);
      if (!a) return send(req, res, 401, { error: "unauthorized" });
      const b = await readBody(req);
      const sym = String(b.symbol || "").trim().toUpperCase();
      delete CUSTOM[sym]; saveCustom();
      try { fs.unlinkSync(storePath("hist", sym)) } catch (e) {}
      return send(req, res, 200, { ok: true });
    }
    if (p === "/api/custom-sources/test" && req.method === "POST") {
      const a = userByToken(req);
      if (!a) return send(req, res, 401, { error: "unauthorized" });
      const b = await readBody(req);
      try {
        const doc = await customHistory("TEST", { url: String(b.url || ""), datePath: String(b.datePath || ""), pricePath: String(b.pricePath || ""), ccy: b.ccy, name: b.name });
        const rows = doc.dates.map((d, i) => [d, doc.raw[i]]);
        return send(req, res, 200, { ok: true, count: rows.length, first: rows.slice(0, 3), lastRows: rows.slice(-3) });
      } catch (e) { return send(req, res, 400, { error: "test_failed", detail: String(e.message || e) }) }
    }

    if (p === "/api/alerts") {
      const a = userByToken(req);
      if (!a) return send(req, res, 401, { error: "unauthorized" });
      let lines = [];
      try { lines = fs.readFileSync(ALERTS_F, "utf8").trim().split("\n").slice(-100) } catch (e) {}
      return send(req, res, 200, { alerts: lines });
    }

    /* ---- 帳號 ---- */
    if (p === "/api/auth/register" && req.method === "POST") {
      const b = await readBody(req);
      const email = String(b.email || "").trim().toLowerCase();
      const pwd = String(b.pwd || "");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(req, res, 400, { error: "bad_email" });
      if (pwd.length < 4) return send(req, res, 400, { error: "weak_pwd" });
      if (Store.exists(email)) return send(req, res, 409, { error: "exists" });
      const salt = crypto.randomBytes(16).toString("hex");
      const rec = { id: crypto.randomUUID(), name: String(b.name || email.split("@")[0]).slice(0, 40), avatar: "🙂", salt, hash: hashPwd(pwd, salt), tokens: [] };
      if (MAIL_ENABLED) { // 郵箱驗證:先入待驗證區,寄送 6 位驗證碼
        const code = genCode();
        Store.pPut(email, { ...rec, code, exp: Date.now() + 15 * 60e3, tries: 0, lastSent: Date.now() });
        try { await sendVerifyCode(email, code) }
        catch (e) { Store.pDel(email); log("smtp fail", String(e.message || e)); return send(req, res, 502, { error: "mail_failed" }) }
        return send(req, res, 200, { pending: true });
      }
      const token = newToken(rec);
      Store.put(email, rec);
      return send(req, res, 200, { token, user: pubUser(rec, email) });
    }
    if (p === "/api/auth/verify" && req.method === "POST") {
      const b = await readBody(req);
      const email = String(b.email || "").trim().toLowerCase();
      const pd = Store.pGet(email);
      if (!pd) return send(req, res, 404, { error: "no_pending" });
      if (Date.now() > pd.exp) { Store.pDel(email); return send(req, res, 400, { error: "code_expired" }) }
      pd.tries = (pd.tries || 0) + 1;
      if (pd.tries > 5) { Store.pDel(email); return send(req, res, 429, { error: "too_many_tries" }) }
      if (String(b.code || "").trim() !== pd.code) { Store.pPut(email, pd); return send(req, res, 401, { error: "bad_code" }) }
      const usr = { id: pd.id, name: pd.name, avatar: pd.avatar, salt: pd.salt, hash: pd.hash, tokens: [] };
      const token = newToken(usr);
      Store.put(email, usr);
      Store.pDel(email);
      return send(req, res, 200, { token, user: pubUser(usr, email) });
    }
    if (p === "/api/auth/resend" && req.method === "POST") {
      const b = await readBody(req);
      const email = String(b.email || "").trim().toLowerCase();
      const pd = Store.pGet(email);
      if (!pd) return send(req, res, 404, { error: "no_pending" });
      if (Date.now() - (pd.lastSent || 0) < 60e3) return send(req, res, 429, { error: "resend_too_fast" });
      pd.code = genCode(); pd.exp = Date.now() + 15 * 60e3; pd.tries = 0; pd.lastSent = Date.now();
      Store.pPut(email, pd);
      try { await sendVerifyCode(email, pd.code) }
      catch (e) { return send(req, res, 502, { error: "mail_failed" }) }
      return send(req, res, 200, { ok: true });
    }
    if (p === "/api/auth/login" && req.method === "POST") {
      const b = await readBody(req);
      const email = String(b.email || "").trim().toLowerCase();
      if (!loginRateOk(email)) return send(req, res, 429, { error: "too_many_attempts", retryAfter: 60 });
      const usr = Store.getByEmail(email);
      if (!usr) return send(req, res, 404, { error: "no_user" });
      if (hashPwd(String(b.pwd || ""), usr.salt) !== usr.hash) return send(req, res, 401, { error: "bad_pwd" });
      const token = newToken(usr); Store.save();
      return send(req, res, 200, { token, user: pubUser(usr, email) });
    }
    if (p === "/api/auth/logout" && req.method === "POST") {
      const a = userByToken(req);
      if (a) { a.u.tokens = a.u.tokens.filter(t => t !== a.token); Store.save() }
      return send(req, res, 200, { ok: true });
    }
    if (p === "/api/auth/password" && req.method === "POST") {
      const a = userByToken(req);
      if (!a) return send(req, res, 401, { error: "unauthorized" });
      const b = await readBody(req);
      if (hashPwd(String(b.oldPwd || ""), a.u.salt) !== a.u.hash) return send(req, res, 401, { error: "bad_pwd" });
      if (String(b.newPwd || "").length < 4) return send(req, res, 400, { error: "weak_pwd" });
      a.u.salt = crypto.randomBytes(16).toString("hex");
      a.u.hash = hashPwd(String(b.newPwd), a.u.salt);
      a.u.tokens = [a.token];
      Store.save();
      return send(req, res, 200, { ok: true });
    }
    if (p === "/api/auth/delete" && req.method === "POST") {
      const a = userByToken(req);
      if (!a) return send(req, res, 401, { error: "unauthorized" });
      const b = await readBody(req);
      // 需以密碼確認,避免 token 被盜後遭惡意刪號
      if (hashPwd(String(b.pwd || ""), a.u.salt) !== a.u.hash) return send(req, res, 401, { error: "bad_pwd" });
      // 1) 刪除組合檔
      Store.pfDel(a.u.id);
      // 2) 刪除用戶記錄(連同 salt/hash/tokens)
      Store.del(a.email);
      // 3) 清掉可能殘留的待驗證記錄
      Store.pDel(a.email);
      log("account deleted", a.email);
      return send(req, res, 200, { ok: true });
    }
    if (p === "/api/me") {
      const a = userByToken(req);
      if (!a) return send(req, res, 401, { error: "unauthorized" });
      if (req.method === "POST") {
        const b = await readBody(req);
        if (b.name) a.u.name = String(b.name).slice(0, 40);
        if (b.avatar) a.u.avatar = String(b.avatar).slice(0, 8);
        Store.save();
      }
      return send(req, res, 200, { user: pubUser(a.u, a.email) });
    }

    /* ---- 投資組合同步 ---- */
    if (p === "/api/portfolio") {
      const a = userByToken(req);
      if (!a) return send(req, res, 401, { error: "unauthorized" });
      if (req.method === "PUT") {
        const b = await readBody(req);
        const doc = {
          txns: Array.isArray(b.txns) ? b.txns.slice(0, 20000) : [],
          settings: (b.settings && typeof b.settings === "object") ? b.settings : {},
          updatedAt: Date.now()
        };
        Store.pfPut(a.u.id, doc);
        return send(req, res, 200, { ok: true, updatedAt: doc.updatedAt });
      }
      return send(req, res, 200, Store.pfGet(a.u.id));
    }

    return send(req, res, 404, { error: "not_found" });
  } catch (e) {
    log("ERR", p, e.message);
    return send(req, res, 500, { error: "server_error", detail: String(e.message || e) });
  }
});

/* ====================== #6 夜間排程預抓(借鏡 Ghostfolio 的 gathering) ====================== */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PREFETCH_HOUR = process.env.PREFETCH_HOUR === undefined ? 5 : +process.env.PREFETCH_HOUR; // 預設台北 05:00 // 本地時間;設 -1 停用
let lastPrefetchDay = "", prefetchRunning = false;
function collectSymbols() {
  const syms = new Set(Object.keys(CUSTOM));
  try { for (const t of Store.pfAllTxns()) if (t.sym) syms.add(t.sym) } catch (e) {}
  return [...syms];
}
async function prefetchAll() {
  if (prefetchRunning) return;
  prefetchRunning = true;
  try {
    const list = collectSymbols();
    log("prefetch start:", list.length, "symbols");
    let ok = 0, fail = 0;
    for (const s of list) {
      try { await smartHistory(s); ok++ } catch (e) { fail++ }
      await sleep(800); // 禮貌性間隔,避免觸發數據源限流
    }
    for (const c of ["HKD", "JPY", "CNY", "TWD", "EUR", "GBP"]) {
      try { await smartFx(c) } catch (e) {}
      await sleep(500);
    }
    // 快取 GC:清除 7 天未更新之短效快取檔
    try {
      const cut = Date.now() - 7 * 864e5;
      for (const f of fs.readdirSync(CACHE_DIR)) {
        const fp = path.join(CACHE_DIR, f);
        if (fs.statSync(fp).mtimeMs < cut) fs.unlinkSync(fp);
      }
    } catch (e) {}
    log(`prefetch done: ok=${ok} fail=${fail}`);
    // 大師持倉 symbol 輪詢:每天更新 1/7,避免一次性打爆 API
    try {
      const guruSyms = collectGuruSymbols();
      if (guruSyms.length) {
        const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 864e5);
        const batch = dayOfYear % 7;
        const chunkSize = Math.ceil(guruSyms.length / 7);
        const todaySyms = guruSyms.slice(batch * chunkSize, (batch + 1) * chunkSize);
        log(`guru prefetch batch ${batch}/7: ${todaySyms.length} symbols`);
        for (const s of todaySyms) {
          try { await smartHistory(s); ok++ } catch (e) { fail++ }
          await sleep(800);
        }
      }
    } catch (e) { log("guru prefetch err", e.message) }
  } finally { prefetchRunning = false }
}

server.requestTimeout = 30000;   // 慢速請求(slowloris)防護
server.headersTimeout = 35000;

if (require.main === module) {
  // CLI:node server.js --build-gurus [id1,id2...] —— 部署後手動初始化大師資料
  if (process.argv.includes("--build-gurus")) {
    const arg = process.argv[process.argv.indexOf("--build-gurus") + 1];
    const ids = arg && !arg.startsWith("--") ? arg.split(",").map(s => s.trim()).filter(Boolean) : null;
    log("building gurus" + (ids ? " " + ids.join(",") : " (all)") + " ...");
    buildAllGurus(ids ? { ids } : {}).then(r => { log("guru build done", JSON.stringify(r)); process.exit(0); })
      .catch(e => { log("guru build error", e.message); process.exit(1); });
  } else {
    // 季度判斷:上次建檔是否在本季度之前
    function needsGuruBuild() {
      const idx = guruIndexRead();
      if (!idx || !idx.updatedAt) return true; // 從未建檔
      const last = new Date(idx.updatedAt);
      const now = new Date();
      const lastQ = Math.floor(last.getMonth() / 3); // 0-3
      const nowQ = Math.floor(now.getMonth() / 3);
      return last.getFullYear() !== now.getFullYear() || lastQ !== nowQ;
    }
    // 啟動流程:先確保大師資料就緒,再開伺服器
    const guruReady = needsGuruBuild()
      ? (log("guru data missing or stale, building ..."), buildAllGurus({}).then(r => log("auto guru build done:", JSON.stringify(r))).catch(e => log("auto guru build err", e.message)))
      : Promise.resolve();
    guruReady.then(() => {
      server.listen(PORT, () => log(`AlphaNexus server v0.1 listening on http://localhost:${PORT}`));
      if (PREFETCH_HOUR >= 0) setInterval(() => {
        const now = new Date(), day = now.toISOString().slice(0, 10);
        if (now.getHours() === PREFETCH_HOUR && lastPrefetchDay !== day) {
          lastPrefetchDay = day;
          prefetchAll().catch(e => log("prefetch err", e.message));
          // 季度自動更新大師(非每日,避免重量 API 調用)
          if (needsGuruBuild()) {
            log("quarterly guru rebuild triggered");
            buildAllGurus({}).then(r => log("quarterly guru done:", JSON.stringify(r))).catch(e => log("quarterly guru err", e.message));
          }
        }
      }, 10 * 60e3);
    });
  }
} else {
  module.exports = { providers, smartHistory, smartFx, mergeSeries, hasNewEvents, loadStore, saveStore, server, jsonPathEval, jsonPathTokens, normDate, customHistory, coingeckoHistory, isSafeUrl, collectSymbols, prefetchAll, CUSTOM, mailer, SMTP, Store, get PENDING(){return Store._raw().PENDING}, parseInfoTable, getGuru, GURUS, guruRead, guruWrite, guruIndexRead, guruIndexWrite, guruPath, computeGuruNavSeries, buildGuruHoldings, buildGuruNav, fetchGuru13F, buildAllGurus, cusipToTicker, CUSIP_TICKER, parseRssItems, newsForSymbol, USE_RSS };
}
