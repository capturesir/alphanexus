#!/usr/bin/env node
/* =========================================================================
   WealthLens Server v3.1 — 零依賴 Node.js (>=18) 後端
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
const ROOT = __dirname;
const PUB = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const CACHE_DIR = path.join(DATA, "cache");    // 短效快取(搜尋/新聞)
const MARKET_DIR = path.join(DATA, "market");  // 市場數據持久庫(歷史價/匯率)
const PORT_DIR = path.join(DATA, "portfolios");
for (const d of [DATA, CACHE_DIR, MARKET_DIR, PORT_DIR]) fs.mkdirSync(d, { recursive: true });

/* ---------------------- 小工具 ---------------------- */
const log = (...a) => console.log(new Date().toISOString(), ...a);
function readJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch (e) { return fb } }
function writeJSON(p, obj) { // 原子寫入
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
/* 統一輸出: {symbol,name,ccy,market,last,dates[],raw[],adj[],dividends[],splits[],source,adjusted} */

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
    const close = (res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
    const adjA = (res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose) || close;
    const dates = [], raw = [], adj = [];
    for (let i = 0; i < res.timestamp.length; i++) {
      if (close[i] == null && adjA[i] == null) continue;
      dates.push(tsToDate(res.timestamp[i]));
      raw.push(close[i] == null ? null : +(close[i] * scale).toFixed(6));
      adj.push(adjA[i] == null ? null : +(adjA[i] * scale).toFixed(6));
    }
    if (!dates.length) throw new Error("no_data");
    const ev = res.events || {};
    const dividends = Object.values(ev.dividends || {}).map(d => ({ date: tsToDate(d.date), amount: +(d.amount * scale).toFixed(6) })).sort((a, b) => a.date < b.date ? -1 : 1);
    const splits = Object.values(ev.splits || {}).map(s => ({ date: tsToDate(s.date), ratio: s.denominator ? s.numerator / s.denominator : 1, text: s.splitRatio || "" })).sort((a, b) => a.date < b.date ? -1 : 1);
    return { symbol, name: meta.shortName || meta.longName || symbol, ccy, market: mktOf(symbol), last: raw[raw.length - 1], dates, raw, adj, dividends, splits, source: "yahoo", adjusted: true };
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
    const dates = [], raw = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(",");
      const px = parseFloat(c[4]);
      if (!c[0] || !isFinite(px)) continue;
      dates.push(c[0]); raw.push(px);
    }
    if (!dates.length) throw new Error("no_data");
    const ccy = /\.hk$/.test(ss) ? "HKD" : /\.jp$/.test(ss) ? "JPY" : "USD";
    return { symbol, name: symbol, ccy, market: mktOf(symbol), last: raw[raw.length - 1], dates, raw, adj: raw.slice(), dividends: [], splits: [], source: "stooq", adjusted: false };
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
  return { symbol, name: cfg.name || symbol, ccy: cfg.ccy || "USD", market: "CUSTOM", last: raw[raw.length - 1], dates, raw, adj: raw.slice(), dividends: [], splits: [], source: "custom", adjusted: false };
}

/* ====================== #7 CoinGecko 加密貨幣 provider ====================== */
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
  return { symbol: symbol.toUpperCase(), name: coin.name || symbol, ccy: "USD", market: "CRYPTO", last: raw[raw.length - 1], dates, raw, adj: raw.slice(), dividends: [], splits: [], source: "coingecko", adjusted: true };
}

/* ====================== 智慧歷史價:持久庫 + 增量 + 備援鏈 ====================== */
async function smartHistory(symbol) {
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
async function smartFx(ccy) {
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
async function getNews(symbols) {
  const key = "news:" + symbols.slice(0, 8).join(",");
  const c = cacheGet(key, TTL.news);
  if (c) return c;
  const nowS = Date.now() / 1000;
  const mapNews = (arr, sym) => (arr || []).map(n => ({
    title: n.title, src: n.publisher || "", url: n.link || "",
    agoH: Math.max(0.1, (nowS - (n.providerPublishTime || nowS)) / 3600), sym: sym || null
  })).filter(n => n.title && n.url);
  const mine = []; let hot = [];
  const jobs = symbols.slice(0, 8).map(async s => {
    try { const j = await fetchAny(YH(`/v1/finance/search?q=${encodeURIComponent(s)}&quotesCount=0&newsCount=4`)); mine.push(...mapNews(j.news, s)) } catch (e) {}
  });
  jobs.push((async () => {
    for (const q of ["stock market", "federal reserve"]) {
      try { const j = await fetchAny(YH(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=6`)); hot.push(...mapNews(j.news, null)) } catch (e) {}
    }
  })());
  await Promise.all(jobs);
  const seen = new Set();
  const dedupe = arr => arr.filter(n => !seen.has(n.url) && seen.add(n.url)).sort((a, b) => a.agoH - b.agoH);
  const out = { mine: dedupe(mine).slice(0, 30), hot: dedupe(hot).slice(0, 20) };
  if (out.mine.length || out.hot.length) cacheSet(key, out); // 全空(離線)不入快取
  return out;
}

/* ---------------------- 帳號系統 ---------------------- */
const USERS_F = path.join(DATA, "users.json");
let USERS = readJSON(USERS_F, {});
function saveUsers() { writeJSON(USERS_F, USERS) }
function hashPwd(pwd, salt) { return crypto.scryptSync(pwd, salt, 32).toString("hex") }
function pubUser(u, email) { return { name: u.name, email, avatar: u.avatar || "🙂" } }
function newToken(u) { const t = crypto.randomBytes(24).toString("hex"); u.tokens = (u.tokens || []).slice(-9); u.tokens.push(t); return t }
function userByToken(req) {
  const h = req.headers["authorization"] || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!t) return null;
  for (const email in USERS) { const u = USERS[email]; if (u.tokens && u.tokens.includes(t)) return { email, u, token: t } }
  return null;
}
function portfolioPath(uid) { return path.join(PORT_DIR, uid + ".json") }

/* ---------------------- HTTP 工具 ---------------------- */
function send(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(obj));
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
  fs.readFile(file, (err, buf) => {
    if (err) {
      if (!p.startsWith("/api")) return fs.readFile(path.join(PUB, "index.html"), (e2, b2) => {
        if (e2) { res.writeHead(404); return res.end("not found") }
        res.writeHead(200, { "Content-Type": MIME[".html"] }); res.end(b2);
      });
      res.writeHead(404); return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
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

/* ---------------------- 路由 ---------------------- */
const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || "?";
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (!p.startsWith("/api")) return serveStatic(req, res, req.url);
  if (!rateOk(ip)) return send(res, 429, { error: "rate_limited" });
  try {
    if (p === "/api/ping") return send(res, 200, { ok: true, t: Date.now() });

    /* ---- 市場數據 ---- */
    if (p === "/api/search") {
      const q = (u.searchParams.get("q") || "").trim();
      if (!q) return send(res, 200, { results: [] });
      try { return send(res, 200, await searchSymbols(q)) }
      catch (e) { return send(res, 502, { error: "no_data" }) }
    }
    if (p === "/api/history") {
      const sym = (u.searchParams.get("symbol") || "").trim();
      if (!sym) return send(res, 400, { error: "missing_symbol" });
      try { return send(res, 200, await smartHistory(sym)) }
      catch (e) { return send(res, 502, { error: "no_data", detail: String(e.message || e) }) }
    }
    if (p === "/api/fx") {
      const ccys = (u.searchParams.get("ccys") || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 12);
      const out = {};
      await Promise.all(ccys.map(async c => { try { out[c] = await smartFx(c) } catch (e) {} }));
      return send(res, 200, out);
    }
    if (p === "/api/news") {
      const syms = (u.searchParams.get("symbols") || "").split(",").map(s => s.trim()).filter(Boolean);
      try { return send(res, 200, await getNews(syms)) }
      catch (e) { return send(res, 200, { mine: [], hot: [] }) }
    }

    /* ---- #5 自訂數據源管理(需登入) ---- */
    if (p === "/api/custom-sources") {
      const a = userByToken(req);
      if (!a) return send(res, 401, { error: "unauthorized" });
      if (req.method === "POST") {
        const b = await readBody(req);
        const sym = String(b.symbol || "").trim().toUpperCase();
        if (!/^[A-Z0-9._\-]{1,24}$/.test(sym)) return send(res, 400, { error: "bad_symbol" });
        if (!isSafeUrl(String(b.url || ""))) return send(res, 400, { error: "bad_url" });
        try { jsonPathTokens(String(b.datePath || "")); jsonPathTokens(String(b.pricePath || "")) }
        catch (e) { return send(res, 400, { error: "bad_path", detail: String(e.message || e) }) }
        CUSTOM[sym] = { url: String(b.url), datePath: String(b.datePath), pricePath: String(b.pricePath), ccy: String(b.ccy || "USD").toUpperCase().slice(0, 5), name: String(b.name || sym).slice(0, 60) };
        saveCustom();
        try { fs.unlinkSync(storePath("hist", sym)) } catch (e) {} // 清庫存,下次請求即用新設定重抓
        return send(res, 200, { ok: true, symbol: sym });
      }
      return send(res, 200, { sources: Object.entries(CUSTOM).map(([s, c]) => ({ symbol: s, ...c })) });
    }
    if (p === "/api/custom-sources/delete" && req.method === "POST") {
      const a = userByToken(req);
      if (!a) return send(res, 401, { error: "unauthorized" });
      const b = await readBody(req);
      const sym = String(b.symbol || "").trim().toUpperCase();
      delete CUSTOM[sym]; saveCustom();
      try { fs.unlinkSync(storePath("hist", sym)) } catch (e) {}
      return send(res, 200, { ok: true });
    }
    if (p === "/api/custom-sources/test" && req.method === "POST") {
      const a = userByToken(req);
      if (!a) return send(res, 401, { error: "unauthorized" });
      const b = await readBody(req);
      try {
        const doc = await customHistory("TEST", { url: String(b.url || ""), datePath: String(b.datePath || ""), pricePath: String(b.pricePath || ""), ccy: b.ccy, name: b.name });
        const rows = doc.dates.map((d, i) => [d, doc.raw[i]]);
        return send(res, 200, { ok: true, count: rows.length, first: rows.slice(0, 3), lastRows: rows.slice(-3) });
      } catch (e) { return send(res, 400, { error: "test_failed", detail: String(e.message || e) }) }
    }

    if (p === "/api/alerts") {
      const a = userByToken(req);
      if (!a) return send(res, 401, { error: "unauthorized" });
      let lines = [];
      try { lines = fs.readFileSync(ALERTS_F, "utf8").trim().split("\n").slice(-100) } catch (e) {}
      return send(res, 200, { alerts: lines });
    }

    /* ---- 帳號 ---- */
    if (p === "/api/auth/register" && req.method === "POST") {
      const b = await readBody(req);
      const email = String(b.email || "").trim().toLowerCase();
      const pwd = String(b.pwd || "");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: "bad_email" });
      if (pwd.length < 4) return send(res, 400, { error: "weak_pwd" });
      if (USERS[email]) return send(res, 409, { error: "exists" });
      const salt = crypto.randomBytes(16).toString("hex");
      const usr = { id: crypto.randomUUID(), name: String(b.name || email.split("@")[0]).slice(0, 40), avatar: "🙂", salt, hash: hashPwd(pwd, salt), tokens: [] };
      const token = newToken(usr);
      USERS[email] = usr; saveUsers();
      return send(res, 200, { token, user: pubUser(usr, email) });
    }
    if (p === "/api/auth/login" && req.method === "POST") {
      const b = await readBody(req);
      const email = String(b.email || "").trim().toLowerCase();
      const usr = USERS[email];
      if (!usr) return send(res, 404, { error: "no_user" });
      if (hashPwd(String(b.pwd || ""), usr.salt) !== usr.hash) return send(res, 401, { error: "bad_pwd" });
      const token = newToken(usr); saveUsers();
      return send(res, 200, { token, user: pubUser(usr, email) });
    }
    if (p === "/api/auth/logout" && req.method === "POST") {
      const a = userByToken(req);
      if (a) { a.u.tokens = a.u.tokens.filter(t => t !== a.token); saveUsers() }
      return send(res, 200, { ok: true });
    }
    if (p === "/api/auth/password" && req.method === "POST") {
      const a = userByToken(req);
      if (!a) return send(res, 401, { error: "unauthorized" });
      const b = await readBody(req);
      if (hashPwd(String(b.oldPwd || ""), a.u.salt) !== a.u.hash) return send(res, 401, { error: "bad_pwd" });
      if (String(b.newPwd || "").length < 4) return send(res, 400, { error: "weak_pwd" });
      a.u.salt = crypto.randomBytes(16).toString("hex");
      a.u.hash = hashPwd(String(b.newPwd), a.u.salt);
      a.u.tokens = [a.token];
      saveUsers();
      return send(res, 200, { ok: true });
    }
    if (p === "/api/me") {
      const a = userByToken(req);
      if (!a) return send(res, 401, { error: "unauthorized" });
      if (req.method === "POST") {
        const b = await readBody(req);
        if (b.name) a.u.name = String(b.name).slice(0, 40);
        if (b.avatar) a.u.avatar = String(b.avatar).slice(0, 8);
        saveUsers();
      }
      return send(res, 200, { user: pubUser(a.u, a.email) });
    }

    /* ---- 投資組合同步 ---- */
    if (p === "/api/portfolio") {
      const a = userByToken(req);
      if (!a) return send(res, 401, { error: "unauthorized" });
      const f = portfolioPath(a.u.id);
      if (req.method === "PUT") {
        const b = await readBody(req);
        const doc = {
          txns: Array.isArray(b.txns) ? b.txns.slice(0, 20000) : [],
          settings: (b.settings && typeof b.settings === "object") ? b.settings : {},
          updatedAt: Date.now()
        };
        writeJSON(f, doc);
        return send(res, 200, { ok: true, updatedAt: doc.updatedAt });
      }
      return send(res, 200, readJSON(f, { txns: [], settings: null, updatedAt: 0 }));
    }

    return send(res, 404, { error: "not_found" });
  } catch (e) {
    log("ERR", p, e.message);
    return send(res, 500, { error: "server_error", detail: String(e.message || e) });
  }
});

/* ====================== #6 夜間排程預抓(借鏡 Ghostfolio 的 gathering) ====================== */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PREFETCH_HOUR = process.env.PREFETCH_HOUR === undefined ? 5 : +process.env.PREFETCH_HOUR; // 預設台北 05:00 // 本地時間;設 -1 停用
let lastPrefetchDay = "", prefetchRunning = false;
function collectSymbols() {
  const syms = new Set(Object.keys(CUSTOM));
  try {
    for (const f of fs.readdirSync(PORT_DIR)) {
      const d = readJSON(path.join(PORT_DIR, f), {});
      for (const t of (d.txns || [])) if (t.sym) syms.add(t.sym);
    }
  } catch (e) {}
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
    log(`prefetch done: ok=${ok} fail=${fail}`);
  } finally { prefetchRunning = false }
}

if (require.main === module) {
  server.listen(PORT, () => log(`WealthLens server v3.1 listening on http://localhost:${PORT}`));
  if (PREFETCH_HOUR >= 0) setInterval(() => {
    const now = new Date(), day = now.toISOString().slice(0, 10);
    if (now.getHours() === PREFETCH_HOUR && lastPrefetchDay !== day) {
      lastPrefetchDay = day;
      prefetchAll().catch(e => log("prefetch err", e.message));
    }
  }, 10 * 60e3);
} else {
  module.exports = { providers, smartHistory, smartFx, mergeSeries, hasNewEvents, loadStore, saveStore, server, jsonPathEval, jsonPathTokens, normDate, customHistory, coingeckoHistory, isSafeUrl, collectSymbols, prefetchAll, CUSTOM };
}
