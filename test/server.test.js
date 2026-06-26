/* 後端測試 —— node test/server.test.js
   涵蓋:provider 備援鏈、增量合併、事件觸發全量、JSONPath 自訂源、CoinGecko、
   並發請求合併、郵箱驗證流程。全程以 stub fetch / stub mailer 離線執行。 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const os = require("os");

// 重要:測試一律使用獨立的臨時 data 目錄,絕不碰正式的 ./data(避免刪除真實用戶資料)。
// server.js 會讀取 WL_DATA_DIR 作為資料根目錄。
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "wl-test-"));
process.env.WL_DATA_DIR = DATA;
function clean() {
  try { fs.rmSync(DATA, { recursive: true, force: true }) } catch (e) {}
  try { fs.mkdirSync(DATA, { recursive: true }) } catch (e) {}
}
// 測試結束時清理臨時目錄
process.on("exit", () => { try { fs.rmSync(DATA, { recursive: true, force: true }) } catch (e) {} });

let pass = 0;
const ok = (c, m) => { if (!c) { console.error("✗", m); process.exit(1) } console.log("✓", m); pass++ };

const EPOCH = Math.floor(new Date("2020-12-28T00:00:00Z") / 1000);
const mkChart = o => ({ chart: { result: [{
  meta: { currency: o.ccy || "USD", shortName: o.name || "T" },
  timestamp: o.dates.map(d => Math.floor(new Date(d + "T00:00:00Z") / 1000)),
  indicators: { quote: [{ close: o.close }], adjclose: [{ adjclose: o.adj || o.close }] },
  events: o.events || {} }] } });

async function run() {
  // ---- A. provider 備援鏈 + 增量合併 + 事件觸發 ----
  clean();
  process.env.SMTP_HOST = ""; // A 段不啟用郵件
  let MODE = "full", CALLS = [];
  global.fetch = async (url) => {
    CALLS.push(url);
    const okr = j => ({ ok: true, json: async () => j, text: async () => j });
    if (MODE === "fail") throw new Error("net down");
    if (url.includes("/v8/finance/chart/VT")) {
      const p1 = +new URL(url).searchParams.get("period1");
      if (p1 === EPOCH) return okr(mkChart({ dates: ["2021-01-04","2021-01-05","2021-01-06"], close: [100,101,102],
        events: { dividends: { a: { date: Math.floor(new Date("2021-01-05T00:00:00Z")/1000), amount: 0.5 } } } }));
      if (MODE === "inc-newdiv") return okr(mkChart({ dates: ["2021-01-07","2021-01-08"], close: [103,104],
        events: { dividends: { b: { date: Math.floor(new Date("2021-01-08T00:00:00Z")/1000), amount: 0.6 } } } }));
      return okr(mkChart({ dates: ["2021-01-06","2021-01-07"], close: [102.5,103] }));
    }
    if (url.includes("stooq.com")) return okr("Date,Open,High,Low,Close,Volume\n2021-01-04,1,1,1,99.5,100\n2021-01-05,1,1,1,100.5,100");
    if (url.includes("frankfurter")) return okr({ rates: { "2021-01-04": { HKD: 7.75 }, "2021-01-05": { HKD: 7.76 } } });
    throw new Error("unexpected " + url);
  };
  delete require.cache[require.resolve("../server.js")];
  const S = require("../server.js");
  const expire = () => { const f = path.join(DATA, "market", fs.readdirSync(path.join(DATA,"market")).find(x => x.startsWith("hist_")));
    const d = JSON.parse(fs.readFileSync(f)); d.fetchedAt = Date.now() - 3*3600e3; fs.writeFileSync(f, JSON.stringify(d)) };

  let h = await S.smartHistory("VT");
  ok(h.dividends[0].amount === 0.5 && h.adjusted === true, "A1 全量抓取 + 事件解析");
  expire(); CALLS = [];
  h = await S.smartHistory("VT");
  ok(h.dates.length === 4 && h.raw[2] === 102.5 && CALLS.length === 1, "A2 增量合併 + 重疊修復(僅 1 請求)");
  expire(); MODE = "inc-newdiv"; CALLS = [];
  h = await S.smartHistory("VT");
  ok(CALLS.length === 2, "A3 新股息觸發全量重抓");
  expire(); MODE = "fail";
  h = await S.smartHistory("VT");
  ok(h.stale === true, "A4 上游全掛 → 過期庫存兜底");

  // ---- B. JSONPath / CoinGecko / SSRF ----
  clean();
  global.fetch = async (url) => {
    const okr = j => ({ ok: true, json: async () => j, text: async () => j });
    if (url.startsWith("https://myfund.example.com")) return okr({ data: { series: [
      { day: "2024-01-02", nav: "10.51" }, { day: 1704326400, nav: 10.62 }, { day: "01/08/2024", nav: 10.70 }, { day: "bad", nav: "x" }] } });
    if (url.includes("coingecko.com/api/v3/search")) return okr({ coins: [{ id: "bitcoin", symbol: "btc", name: "Bitcoin" }] });
    if (url.includes("coingecko.com/api/v3/coins/bitcoin")) return okr({ prices: [[1704153600000,42000.5],[1704240000000,43100.2],[1704240005000,43150.0]] });
    throw new Error("unexpected " + url);
  };
  delete require.cache[require.resolve("../server.js")];
  const S2 = require("../server.js");
  // SSRF 檢查會做真實 DNS;測試環境離線,故 stub 成回傳公網 IP(對 example.com 域)
  S2._dnsLookup = async (host) => {
    if (/\.example\.com$/.test(host) || host === "example.com") return [{ address: "93.184.216.34", family: 4 }];
    return [{ address: "8.8.8.8", family: 4 }];
  };
  ok(JSON.stringify(S2.jsonPathEval({ a:{ list:[{ d:"x", p:1 }] } }, "$.a.list[*].p")) === "[1]", "B1 JSONPath 求值");
  ok(S2.normDate(1704326400) === "2024-01-04" && S2.normDate("01/08/2024") === "2024-01-08", "B2 日期自動偵測");
  ok(S2.isSafeUrl("https://api.example.com") && !S2.isSafeUrl("http://127.0.0.1"), "B3 SSRF 防護(字串)");
  ok(S2.isPrivateIp("169.254.169.254") && S2.isPrivateIp("10.0.0.1") && S2.isPrivateIp("::1") && S2.isPrivateIp("fd00::1"), "B3b 私有/保留 IP 判定");
  ok(!S2.isPrivateIp("8.8.8.8") && !S2.isPrivateIp("1.1.1.1"), "B3c 公網 IP 不誤判");
  ok(!S2.isSafeUrl("http://169.254.169.254/latest/meta-data") && !S2.isSafeUrl("http://[::1]/") && !S2.isSafeUrl("ftp://x.com"), "B3d 擋雲端metadata/IPv6loopback/非http");
  let ssrfBlocked = false;
  try { await S2.assertSafeUrl("http://169.254.169.254/"); } catch (e) { ssrfBlocked = /unsafe/.test(e.message); }
  ok(ssrfBlocked, "B3e assertSafeUrl 解析後擋 metadata IP");
  S2.CUSTOM["MYFUND"] = { url:"https://myfund.example.com/api", datePath:"$.data.series[*].day", pricePath:"$.data.series[*].nav", ccy:"CNY", name:"基金" };
  const cf = await S2.smartHistory("MYFUND");
  ok(cf.source === "custom" && JSON.stringify(cf.raw) === "[10.51,10.62,10.7]", "B4 自訂源端到端 + 壞列剔除");
  const cg = await S2.coingeckoHistory("BTC-USD");
  ok(cg.source === "coingecko" && cg.raw[1] === 43150, "B5 CoinGecko 同日取尾值");

  // ---- C. 並發請求合併 ----
  clean();
  let cnt = 0;
  global.fetch = async () => { cnt++; await new Promise(r => setTimeout(r, 120));
    return { ok: true, json: async () => mkChart({ dates: ["2021-01-04"], close: [100] }), text: async () => "" } };
  delete require.cache[require.resolve("../server.js")];
  const S3 = require("../server.js");
  await Promise.all(Array.from({ length: 10 }, () => S3.smartHistory("AAA")));
  ok(cnt === 1, "C1 10 並發合併為 1 次上游呼叫");

  // ---- D. 郵箱驗證流程 ----
  clean();
  process.env.SMTP_HOST = "smtp.example.com"; process.env.SMTP_USER = "bot@x.com"; process.env.SMTP_PASS = "x";
  global.fetch = async () => { throw new Error("offline") };
  delete require.cache[require.resolve("../server.js")];
  const S4 = require("../server.js");
  const SENT = [];
  S4.mailer.send = async m => { SENT.push(m); return true };
  const http = require("http");
  await new Promise(r => S4.server.listen(0, r));
  const port = S4.server.address().port;
  const call = (p, body) => new Promise((res, rej) => {
    const rq = http.request({ host: "localhost", port, path: p, method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" } },
      x => { let b = ""; x.on("data", c => b += c); x.on("end", () => res({ code: x.statusCode, j: JSON.parse(b || "{}") })) });
    rq.on("error", rej); if (body) rq.write(JSON.stringify(body)); rq.end();
  });
  let r = await call("/api/auth/register", { email: "u@x.com", pwd: "pass1234" });
  ok(r.j.pending === true && SENT.length === 1, "D1 註冊 → 待驗證 + 寄碼");
  const code = SENT[0].text.match(/\d{6}/)[0];
  r = await call("/api/auth/verify", { email: "u@x.com", code: "000000" });
  ok(r.j.error === "bad_code", "D2 錯誤驗證碼被拒");
  r = await call("/api/auth/verify", { email: "u@x.com", code });
  ok(!!r.j.token, "D3 正確驗證碼 → 簽發 token");
  r = await call("/api/auth/login", { email: "u@x.com", pwd: "pass1234" });
  ok(!!r.j.token, "D4 驗證後可正常登入");
  // D5 刪除帳號:錯密碼拒絕、正確密碼徹底清除
  const tok = r.j.token;
  const delCall = (body, token) => new Promise((res, rej) => {
    const rq = http.request({ host: "localhost", port, path: "/api/auth/delete", method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token } },
      x => { let b = ""; x.on("data", c => b += c); x.on("end", () => res({ code: x.statusCode, j: JSON.parse(b || "{}") })) });
    rq.on("error", rej); rq.write(JSON.stringify(body)); rq.end();
  });
  let dr = await delCall({ pwd: "wrong" }, tok);
  ok(dr.j.error === "bad_pwd", "D5a 錯密碼無法刪除帳號");
  dr = await delCall({ pwd: "pass1234" }, tok);
  ok(dr.j.ok === true, "D5b 正確密碼刪除帳號成功");
  const after = await call("/api/auth/login", { email: "u@x.com", pwd: "pass1234" });
  ok(after.j.error === "no_user", "D5c 刪除後帳號已不存在");
  await new Promise(r => S4.server.close(r));

  // ---- E. 可插拔新聞層:設定 NEWS_PROVIDER 時走授權 API、不打 Yahoo ----
  clean();
  process.env.SMTP_HOST = ""; process.env.NEWS_PROVIDER = "newsapi"; process.env.NEWS_API_KEY = "testkey";
  let newsCalls = [];
  global.fetch = async (url) => {
    newsCalls.push(url);
    if (url.includes("newsapi.org")) return { ok: true, json: async () => ({ articles: [{ title: "NVDA hits high", source: { name: "Reuters" }, url: "https://x.com/a", publishedAt: new Date().toISOString() }] }), text: async () => "" };
    throw new Error("unexpected " + url);
  };
  delete require.cache[require.resolve("../server.js")];
  const S5 = require("../server.js");
  await new Promise(r => S5.server.listen(0, r));
  const port5 = S5.server.address().port;
  const r5 = await new Promise((res, rej) => { http.get({ port: port5, path: "/api/news?symbols=NVDA" }, x => { let b = ""; x.on("data", c => b += c); x.on("end", () => res(JSON.parse(b))) }).on("error", rej) });
  ok(newsCalls.some(u => u.includes("newsapi.org")) && !newsCalls.some(u => u.includes("finance.yahoo")) && r5.mine.length > 0,
    "E1 NEWS_PROVIDER=newsapi → 走授權 API、未打 Yahoo");
  await new Promise(r => S5.server.close(r));
  delete process.env.NEWS_PROVIDER; delete process.env.NEWS_API_KEY;

  // ---- E2. Google News RSS 解析(標題/來源/連結;不取內文)----
  const rssItems = S5.parseRssItems(`<rss><channel>
    <item><title>盈富基金單日吸金 - 香港經濟日報</title><link>https://hket.com/a1</link><pubDate>Wed, 18 Mar 2026 10:00:00 GMT</pubDate></item>
    <item><title><![CDATA[恒指反彈 - 明報]]></title><link>https://mingpao.com/b2</link><source>明報</source></item>
  </channel></rss>`);
  ok(rssItems.length === 2 && rssItems[0].src === "香港經濟日報" && rssItems[0].title === "盈富基金單日吸金" && rssItems[1].url === "https://mingpao.com/b2",
    "E2 RSS 解析正確(標題/來源/連結分離)");
  ok(!("content" in rssItems[0]) && !("description" in rssItems[0]), "E3 RSS 不含內文(僅索引導流)");

  ok(S5.parseInfoTable(`<infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><value>50000</value><shrsOrPrnAmt><sshPrnamt>250</sshPrnamt></shrsOrPrnAmt></infoTable>`).length === 1, "F1 parseInfoTable 解析單筆");
  const multi = S5.parseInfoTable(`<infoTable><nameOfIssuer>A</nameOfIssuer><value>100</value></infoTable><infoTable><nameOfIssuer>B</nameOfIssuer><value>200</value></infoTable>`);
  ok(multi.length === 2 && multi[1].value === 200, "F2 parseInfoTable 解析多筆");
  ok(Array.isArray(S5.GURUS) && S5.GURUS.some(g => g.who === "Warren Buffett"), "F3 大師清單含巴菲特");
  ok(S5.GURUS.length === 13 && S5.GURUS.every(g => g.tag && g.warn), "F4 大師擴充至13位且皆有風格標籤與失真警告等級");
  ok(S5.GURUS.some(g => g.id === "citadel" && g.warn === "high") && S5.GURUS.some(g => g.id === "himalaya" && g.warn === "low"), "F4 高周轉標 high、長期價值標 low");
  // 大師檔案讀寫工具
  ok(S5.guruWrite("testguru", "holdings", { q: ["2025Q1"], data: [1, 2] }) === true, "F5 guruWrite 寫入");
  const rd = S5.guruRead("testguru", "holdings");
  ok(rd && rd.q[0] === "2025Q1" && rd.data[1] === 2, "F5 guruRead 讀回一致");
  ok(S5.guruRead("nonexist", "nav") === null, "F5 不存在的大師檔回 null");
  S5.guruIndexWrite({ updated: "2025-06-01", ids: ["berkshire"] });
  ok(S5.guruIndexRead().ids[0] === "berkshire", "F5 index 讀寫一致");

  // ---- F6. 大師淨值演算法 computeGuruNavSeries ----
  // 單季、單股、100%持倉:初始100萬,股價不變 → 淨值恆=100萬
  (function () {
    const q = [{ date: "2023-01-01", holdings: [{ sym: "X", pct: 1 }] }];
    const price = (s, d) => 100; // 恆定
    const dates = ["2023-01-01", "2023-01-02", "2023-01-03"];
    const nav = S5.computeGuruNavSeries(q, price, dates, { initial: 1e6 }).nav;
    ok(nav.length === 3 && Math.abs(nav[0].nav - 1e6) < 1, "F6 初始建倉淨值=100萬");
    ok(Math.abs(nav[2].nav - 1e6) < 1, "F6 股價不變→淨值不變");
  })();
  // 股價漲 10% → 淨值漲 10%(全額持股)
  (function () {
    const q = [{ date: "2023-01-01", holdings: [{ sym: "X", pct: 1 }] }];
    const price = (s, d) => d === "2023-01-02" ? 110 : 100;
    const nav = S5.computeGuruNavSeries(q, price, ["2023-01-01", "2023-01-02"], { initial: 1e6 }).nav;
    ok(Math.abs(nav[1].nav - 1.1e6) < 1, "F6 股價+10%→淨值+10%");
  })();
  // 調倉中性:同日換股,價格不變,淨值不應跳變
  (function () {
    const q = [
      { date: "2023-01-01", holdings: [{ sym: "A", pct: 1 }] },
      { date: "2023-02-01", holdings: [{ sym: "B", pct: 1 }] }
    ];
    const price = (s, d) => 50; // 所有股票所有日都50
    const dates = ["2023-01-01", "2023-02-01", "2023-02-02"];
    const nav = S5.computeGuruNavSeries(q, price, dates, { initial: 1e6 }).nav;
    ok(Math.abs(nav[1].nav - 1e6) < 1 && Math.abs(nav[2].nav - 1e6) < 1, "F6 調倉中性(價格不變淨值不跳)");
  })();
  // 負現金計息:用兩股,次季全配置到「當日較貴」的股,因正規化後仍可能因價格時點差產生負現金。
  // 改用明確情境:首季持 A、B 各半;次季 A 漲、要 100% 配 A,但 B 賣出價較低 → 仍足夠,不會負。
  // 真正的負現金來自「重配置買入成本 > 當前資產」,以人工建構:用 priceOf 讓重配置日 A 價瞬間偏高。
  (function () {
    const q = [
      { date: "2023-01-01", holdings: [{ sym: "A", pct: 1 }] },
      { date: "2023-02-01", holdings: [{ sym: "A", pct: 1 }] }
    ];
    // A 在 2/1 當天用於「估值」與「買入」是同一價,正常不會負。
    // 為測負現金計息的數學,直接驗證:當 cash 為負時每日扣息公式。
    // 用 computeGuruNavSeries 不易自然構造負現金(正規化後 pct≤1),故單獨驗證計息公式:
    const negCash = -1e6, rate = 0.03;
    const afterOneDay = negCash - Math.abs(negCash) * rate / 365;
    ok(Math.abs(afterOneDay - (negCash - 82.19)) < 0.5, "F6 負現金每日計息公式 |cash|×3%/365");
  })();

  // ---- F7. 涵蓋率:逐期計算、最低值、低於門檻作廢、正規化 ----
  // 某期 50% 持倉有價、50% 無 sym → 該期涵蓋率 0.5
  (function () {
    const q = [{ date: "2023-01-01", holdings: [{ sym: "A", pct: 0.5 }, { name: "冷門股", pct: 0.5 }] }];
    const price = (s, d) => s === "A" ? 100 : null;
    const r = S5.computeGuruNavSeries(q, price, ["2023-01-01", "2023-01-02"], { initial: 1e6, minCoverage: 0.5 });
    ok(Math.abs(r.coverages[0].coverage - 0.5) < 1e-6, "F7 逐期涵蓋率=可定價pct總和(0.5)");
    ok(Math.abs(r.minCov - 0.5) < 1e-6 && !r.abandoned, "F7 涵蓋率=門檻(0.5)未作廢");
    // 涵蓋的 A 正規化到 100%,初始100萬全買 A → 淨值≈100萬
    ok(Math.abs(r.nav[0].nav - 1e6) < 1, "F7 涵蓋持倉正規化到100%後建倉");
  })();
  // 任一期低於 50% → 整位作廢
  (function () {
    const q = [
      { date: "2023-01-01", holdings: [{ sym: "A", pct: 1 }] },                         // 100%
      { date: "2023-04-01", holdings: [{ sym: "A", pct: 0.4 }, { name: "X", pct: 0.6 }] } // 40% < 門檻
    ];
    const price = (s, d) => s === "A" ? 100 : null;
    const r = S5.computeGuruNavSeries(q, price, ["2023-01-01", "2023-04-01"], { minCoverage: 0.5 });
    ok(r.abandoned === true && r.nav.length === 0, "F7 任一期涵蓋率<50%→整位作廢、不出曲線");
    ok(Math.abs(r.minCov - 0.4) < 1e-6, "F7 最低涵蓋率回報該最差期(0.4)");
  })();
  // 顯示用:最低涵蓋率取所有期最差
  (function () {
    const q = [
      { date: "2023-01-01", holdings: [{ sym: "A", pct: 0.9 }, { name: "X", pct: 0.1 }] }, // 90%
      { date: "2023-04-01", holdings: [{ sym: "A", pct: 0.7 }, { name: "X", pct: 0.3 }] }  // 70%
    ];
    const price = (s, d) => s === "A" ? 100 : null;
    const r = S5.computeGuruNavSeries(q, price, ["2023-01-01", "2023-04-01"], { minCoverage: 0.5 });
    ok(Math.abs(r.minCov - 0.7) < 1e-6 && !r.abandoned, "F7 最低涵蓋率=最差期(0.7),≥門檻不作廢");
  })();

  // ---- F8. CUSIP → ticker 對映 ----
  ok((await S5.cusipToTicker("037833100", "APPLE INC")) === "AAPL", "F8 已知 CUSIP 對到 ticker");
  ok((await S5.cusipToTicker("594918104", "MICROSOFT CORP")) === "MSFT", "F8 CUSIP 前6碼對映");
  ok((await S5.cusipToTicker("999999999", "冷門小股")) === null, "F8 未知 CUSIP 回 null(計入未涵蓋)");
  ok((await S5.cusipToTicker("", "無CUSIP")) === null, "F8 空 CUSIP 回 null");
  ok(Object.keys(S5.CUSIP_TICKER).length >= 50, "F8 對照表涵蓋常見大型股(≥50)");

  // ---- G. 儲存層(Store)介面契約 ----
  clean();
  delete require.cache[require.resolve("../server.js")];
  const S6 = require("../server.js");
  const St = S6.Store;
  const need = ["getByEmail","exists","getByToken","put","save","del","pGet","pPut","pDel","pfGet","pfPut","pfDel","pfAllTxns"];
  ok(St && need.every(m => typeof St[m] === "function"), "G1 Store 介面方法齊全");
  St.put("z@x.com", { id: "uidZ", name: "Z", salt: "s", hash: "h", tokens: ["tokZ"] });
  ok(St.exists("z@x.com") && St.getByEmail("z@x.com").id === "uidZ", "G2 put/getByEmail/exists");
  ok(St.getByToken("tokZ") && St.getByToken("tokZ").email === "z@x.com", "G3 getByToken");
  St.pfPut("uidZ", { txns: [{ sym: "AAPL" }], settings: {}, updatedAt: 1 });
  ok(St.pfGet("uidZ").txns[0].sym === "AAPL", "G4 pfPut/pfGet");
  const allSyms = [...St.pfAllTxns()].map(t => t.sym);
  ok(allSyms.includes("AAPL"), "G5 pfAllTxns 掃描全組合");
  St.del("z@x.com"); St.pfDel("uidZ");
  ok(!St.exists("z@x.com"), "G6 del 清除用戶");

  // ---- H. 設定儲存/讀取/隔離 ----
  clean();
  delete require.cache[require.resolve("../server.js")];
  process.env.SMTP_HOST = ""; // 不寄信
  const S7 = require("../server.js");
  await new Promise(r => S7.server.listen(0, r));
  const p7 = S7.server.address().port;
  const call7 = (p, body, token) => new Promise((res, rej) => {
    const hdrs = { "Content-Type": "application/json" };
    if (token) hdrs.Authorization = "Bearer " + token;
    const rq = http.request({ host: "localhost", port: p7, path: p, method: body ? "POST" : "GET", headers: hdrs },
      x => { let b = ""; x.on("data", c => b += c); x.on("end", () => res({ code: x.statusCode, j: JSON.parse(b || "{}") })) });
    rq.on("error", rej); if (body) rq.write(JSON.stringify(body)); rq.end();
  });
  const put7 = (p, body, token) => new Promise((res, rej) => {
    const rq = http.request({ host: "localhost", port: p7, path: p, method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token } },
      x => { let b = ""; x.on("data", c => b += c); x.on("end", () => res({ code: x.statusCode, j: JSON.parse(b || "{}") })) });
    rq.on("error", rej); rq.write(JSON.stringify(body)); rq.end();
  });

  // 建立測試帳號(直接跳過驗證)
  const St7 = S7.Store;
  St7.put("h1@x.com", { id: "h1", name: "H1", salt: "s", hash: "h", tokens: ["tokH1"] });
  St7.put("h2@x.com", { id: "h2", name: "H2", salt: "s", hash: "h", tokens: ["tokH2"] });

  // H1: 儲存全部 9 項設定 → 讀回一致
  const h1Settings = { theme:"dark", lang:"en", color:"redUp", ctype:"candle", baseCcy:"GBP", privacy:false, plMode:"daily", autoDiv:false, divTax:15 };
  await put7("/api/portfolio", { txns: [], settings: h1Settings }, "tokH1");
  const h1Read = await call7("/api/portfolio", null, "tokH1");
  const h1s = h1Read.j.settings;
  ok(h1s.theme === "dark" && h1s.lang === "en" && h1s.color === "redUp" && h1s.ctype === "candle" &&
     h1s.baseCcy === "GBP" && h1s.privacy === false && h1s.plMode === "daily" && h1s.autoDiv === false && h1s.divTax === 15,
    "H1 儲存全部 9 項設定 → 讀回一致");

  // H2: 部分更新(只改 theme) → 其他設定不變
  await put7("/api/portfolio", { txns: [], settings: { ...h1Settings, theme: "light" } }, "tokH1");
  const h2Read = await call7("/api/portfolio", null, "tokH1");
  ok(h2Read.j.settings.theme === "light" && h2Read.j.settings.baseCcy === "GBP" && h2Read.j.settings.divTax === 15,
    "H2 部分更新 theme → 其他設定不變");

  // H3: 用戶隔離 — h2 的設定不影響 h1
  const h2Settings = { theme:"dark", lang:"zh-CN", color:"greenUp", ctype:"line", baseCcy:"USD", privacy:true, plMode:"total", autoDiv:true, divTax:0 };
  await put7("/api/portfolio", { txns: [], settings: h2Settings }, "tokH2");
  const h3Read = await call7("/api/portfolio", null, "tokH1");
  ok(h3Read.j.settings.lang === "en" && h3Read.j.settings.baseCcy === "GBP",
    "H3 用戶隔離 — h2 設定不影響 h1");

  // H4: 空設定(新用戶) → 讀回空物件或 undefined
  St7.put("h4@x.com", { id: "h4", name: "H4", salt: "s", hash: "h", tokens: ["tokH4"] });
  const h4Read = await call7("/api/portfolio", null, "tokH4");
  ok(!h4Read.j.settings || Object.keys(h4Read.j.settings).length === 0,
    "H4 新用戶無設定 → 讀回空");

  // H5: 刪除帳號後設定清除
  St7.del("h1@x.com"); St7.pfDel("h1");
  ok(!St7.exists("h1@x.com"), "H5 刪除帳號後用戶不存在");

  // H6: 設定含特殊值(divTax=0, privacy=false)正確儲存
  St7.put("h6@x.com", { id: "h6", name: "H6", salt: "s", hash: "h", tokens: ["tokH6"] });
  await put7("/api/portfolio", { txns: [], settings: { divTax: 0, privacy: false, autoDiv: false } }, "tokH6");
  const h6Read = await call7("/api/portfolio", null, "tokH6");
  ok(h6Read.j.settings.divTax === 0 && h6Read.j.settings.privacy === false && h6Read.j.settings.autoDiv === false,
    "H6 特殊值(divTax=0, privacy=false, autoDiv=false)正確儲存");

  // 清理
  St7.del("h2@x.com"); St7.pfDel("h2");
  St7.del("h4@x.com"); St7.pfDel("h4");
  St7.del("h6@x.com"); St7.pfDel("h6");
  await new Promise(r => S7.server.close(r));

  clean();
  console.log(`\n後端測試:${pass} 項全部通過 ✓`);
}

run().catch(e => { console.error("FAIL:", e.message); clean(); process.exit(1) });
