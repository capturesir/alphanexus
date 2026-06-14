/* 後端測試 —— node test/server.test.js
   涵蓋:provider 備援鏈、增量合併、事件觸發全量、JSONPath 自訂源、CoinGecko、
   並發請求合併、郵箱驗證流程。全程以 stub fetch / stub mailer 離線執行。 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "../data");
function clean() { try { fs.rmSync(DATA, { recursive: true, force: true }) } catch (e) {} }

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
  ok(JSON.stringify(S2.jsonPathEval({ a:{ list:[{ d:"x", p:1 }] } }, "$.a.list[*].p")) === "[1]", "B1 JSONPath 求值");
  ok(S2.normDate(1704326400) === "2024-01-04" && S2.normDate("01/08/2024") === "2024-01-08", "B2 日期自動偵測");
  ok(S2.isSafeUrl("https://api.example.com") && !S2.isSafeUrl("http://127.0.0.1"), "B3 SSRF 防護");
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

  clean();
  console.log(`\n後端測試:${pass} 項全部通過 ✓`);
}

run().catch(e => { console.error("FAIL:", e.message); clean(); process.exit(1) });
