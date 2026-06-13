/* 前端會計引擎回歸測試 —— node test/engine.test.js
   以 stub DOM 載入 index.html 的前三個 script 區塊(狀態+引擎),驗證核心會計數值。 */
"use strict";
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
global.location = { protocol: "http:" };
global.window = {};
global.document = { querySelector: () => null, querySelectorAll: () => [] };
global.fetch = async () => { throw new Error("offline") };

let code = scripts.slice(0, 3).join("\n;\n").replace(/"use strict";/g, "");
code = code.slice(0, code.indexOf("/* ====================== 資產列表 UI"));

let pass = 0;
const ok = (c, m) => { if (!c) { console.error("✗", m); process.exit(1) } console.log("✓", m); pass++ };

const tests = `
LIVE = true; state.settings.baseCcy = 'USD';

// (a) 除淨日 NAV 恆等 + TWR 中立
const raw = new Float64Array(N_DAYS).fill(100);
const exIdx = dIdx(new Date('2024-03-15'));
for (let i = exIdx; i < N_DAYS; i++) raw[i] = 98;
REAL.series['DIVX'] = { raw, adj: raw }; registerSym({ s:'DIVX', n:'X', z:'X', m:'US', c:'USD' });
state.txns = [
  { id:'1', kind:'cash', ccy:'USD', loc:'A', amount:10000, date:'2024-01-02' },
  { id:'2', kind:'stock', sym:'DIVX', ccy:'USD', loc:'A', side:'buy', price:100, units:50, date:'2024-02-01' },
  { id:'3', kind:'dividend', sym:'DIVX', ccy:'USD', loc:'A', amount:100, date:'2024-03-15' }];
let D = buildDaily(null);
ok(Math.abs(D.values[exIdx - D.i0] - 10000) < 1e-6, '(a) 除淨日 NAV 平滑不變');
ok(Math.abs(twrCurve(D).slice(-1)[0] - 1) < 1e-9, '(a) 價跌+股息抵銷 TWR=0%');

// (b) 拆股交易單位數重述
const r2 = new Float64Array(N_DAYS).fill(100);
REAL.series['SPLT'] = { raw: r2, adj: r2 };
REAL.events['SPLT'] = { dividends: [], splits: [{ date:'2024-06-10', ratio:4, text:'4:1' }] };
registerSym({ s:'SPLT', n:'S', z:'S', m:'US', c:'USD' });
state.txns = [
  { id:'1', kind:'cash', ccy:'USD', loc:'A', amount:50000, date:'2024-01-02' },
  { id:'2', kind:'stock', sym:'SPLT', ccy:'USD', loc:'A', side:'buy', price:400, units:10, date:'2024-02-01' }];
D = buildDaily(null);
ok(Math.abs(D.values.slice(-1)[0] - 50000) < 1e-6, '(b) 拆股重述後 NAV 正確');
const h = holdingsDetail(null).list.find(x => x.sym === 'SPLT');
ok(Math.abs(h.units - 40) < 1e-9 && Math.abs(h.cost - 4000) < 1e-6, '(b) 重述持倉 40 股、成本 $4000');

// (c) 期權現金=外部流,TWR 中立
state.txns = [
  { id:'1', kind:'cash', ccy:'USD', loc:'A', amount:10000, date:'2024-01-02' },
  { id:'2', kind:'option', sym:'O', ccy:'USD', loc:'A', side:'buy', price:30, units:100, date:'2024-03-01' },
  { id:'3', kind:'option', sym:'O', ccy:'USD', loc:'A', side:'sell', price:55, units:100, date:'2024-05-01' }];
D = buildDaily(null);
ok(Math.abs(twrCurve(D).slice(-1)[0] - 1) < 1e-9, '(c) 期權獲利不影響 TWR');
ok(Math.abs(D.values.slice(-1)[0] - 12500) < 1e-6, '(c) 期權現金進出正確 12500');

// (d) FEE/LIABILITY 內部支出
state.txns = [
  { id:'1', kind:'cash', ccy:'USD', loc:'A', amount:10000, date:'2024-01-02' },
  { id:'2', kind:'fee', ccy:'USD', loc:'A', amount:120, date:'2024-04-01' },
  { id:'3', kind:'liability', ccy:'USD', loc:'A', amount:80, date:'2024-05-01' }];
D = buildDaily(null);
ok(Math.abs(D.values.slice(-1)[0] - 9800) < 1e-6 && Math.abs(D.flows.reduce((s,v)=>s+v,0) - 10000) < 1e-6, '(d) 費用減現金、不入資金流');
ok(Math.abs(holdingsDetail(null).expenseTotal - 200) < 1e-6, '(d) 累計支出 $200');

// (e) 自動股息:去重 / 多位置 / 稅率 / 跳過清單
REAL.events['DIVX'] = { dividends: [{ date:'2024-03-15', amount:2 }, { date:'2024-09-16', amount:2.5 }], splits: [] };
state.settings.divTax = 30; state.settings.autoDiv = true; state.settings.divSkip = [];
state.txns = [
  { id:'1', kind:'cash', ccy:'USD', loc:'富途', amount:10000, date:'2024-01-02' },
  { id:'2', kind:'stock', sym:'DIVX', ccy:'USD', loc:'富途', side:'buy', price:100, units:30, date:'2024-02-01' },
  { id:'3', kind:'stock', sym:'DIVX', ccy:'USD', loc:'中銀', side:'buy', price:100, units:20, date:'2024-02-01' },
  { id:'4', kind:'dividend', sym:'DIVX', ccy:'USD', loc:'富途', amount:60, date:'2024-03-14' }];
reconcileAutoDividends();
const autos = state.txns.filter(t => t.auto);
ok(autos.length === 2, '(e) 3/15 去重、9/16 兩位置自動入帳');
ok(Math.abs(autos.find(t => t.loc === '富途').amount - 52.5) < 1e-9, '(e) 30% 稅後 $52.5');
ok(Math.abs(autos.find(t => t.loc === '中銀').amount - 35) < 1e-9, '(e) 中銀 $35');
state.settings.divTax = 0;
ok(reapplyDivTax() === 2 && Math.abs(autos.find(t => t.loc === '富途').amount - 75) < 1e-9, '(e) 改 0% 稅率重算');
state.settings.divSkip = ['DIVX|2024-09-16'];
state.txns = state.txns.filter(t => !t.auto);
ok(!reconcileAutoDividends(), '(e) 跳過清單生效,刪除後不重生');

// (f) MWR 累積口徑:無外部現金流時 MWR累積 ≈ TWR累積(做法一)
const fpx = new Float64Array(N_DAYS);
const fb = dIdx(new Date('2024-01-01'));
for (let i = 0; i < N_DAYS; i++) fpx[i] = i < fb ? 50 : 50 + 70 * (i - fb) / (N_DAYS - 1 - fb);
REAL.series['MWX'] = { raw: fpx, adj: fpx }; REAL.events['MWX'] = { dividends: [], splits: [] };
registerSym({ s:'MWX', n:'M', z:'M', m:'US', c:'USD' });
state.settings.autoDiv = false;
state.txns = [
  { id:'1', kind:'cash', ccy:'USD', loc:'A', amount:50000, date:'2024-01-01' },
  { id:'2', kind:'stock', sym:'MWX', ccy:'USD', loc:'A', side:'buy', price:50, units:1000, date:'2024-01-01' }];
let Df = buildDaily(null);
let lastf = Df.values.length - 1, k0f = Math.max(0, lastf - 365);
let twf = twrCurve(Df);
ok(Math.abs((twf[lastf]/twf[k0f]-1) - mwrCumOf(Df, k0f, lastf)) < 1e-3, '(f) 無現金流時 MWR累積 ≈ TWR累積');
// 加入期中現金流 → 兩者分岔
state.txns.push({ id:'3', kind:'cash', ccy:'USD', loc:'A', amount:30000, date: fmtD(DATES[Df.i0 + Math.max(1,lastf-60)]) });
state.txns.push({ id:'4', kind:'stock', sym:'MWX', ccy:'USD', loc:'A', side:'buy', price: fpx[Math.max(1,lastf-60)], units:500, date: fmtD(DATES[Df.i0 + Math.max(1,lastf-60)]) });
Df = buildDaily(null); lastf = Df.values.length - 1; twf = twrCurve(Df);
ok(Math.abs((twf[lastf]/twf[0]-1) - mwrCumOf(Df, 0, lastf)) > 1e-4, '(f) 有現金流時 MWR累積 與 TWR累積 分岔');
`;

eval(code + "\n;\n" + tests);
console.log(`\n前端引擎回歸:${pass} 項全部通過 ✓`);
