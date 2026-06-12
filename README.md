# WealthLens — 投資組合管理平台(全端版)

手機優先的多語言(繁/簡/英)投資組合追蹤平台,支援即時與歷史市場數據、TWR/MWR 績效、
多貨幣換算、手勢圖表(捏合縮放/拖動)、ETF 比較、真實帳號系統與雲端同步。

## 專案結構

```
wealthlens/
├── server.js          # 零依賴 Node.js 後端(>= Node 18,無需 npm install)
├── public/
│   └── index.html     # 前端(單檔,含全部 CSS/JS)
├── package.json
└── data/              # 啟動後自動建立:用戶、組合、數據快取
```

## 快速啟動

```bash
node server.js          # 預設 http://localhost:8080
PORT=3000 node server.js  # 自訂埠
```

打開瀏覽器進入 http://localhost:8080 即可。**零依賴**——不需要 `npm install`,
只要機器裝有 Node.js 18 以上(內建 fetch)。

## 部署 / 郵箱驗證 / 防護(v3.2)

- 從零開始的 VPS 部署教學(反向代理 + 自動 HTTPS + 備份 + Cloudflare):見 **DEPLOY.md**。
- **郵箱驗證註冊**:設定 `SMTP_HOST / SMTP_PORT(465) / SMTP_USER / SMTP_PASS / SMTP_FROM` 即啟用——註冊寄 6 位驗證碼(15 分鐘有效、60 秒重寄限速、錯 5 次鎖定),驗證後才建立帳號;未設定則為免驗證模式(自用)。
- **流量優化**:>1KB 之 API JSON 與文字靜態檔自動 gzip(歷史序列實測縮小 8–12 倍,首頁 3 倍)。
- **抗壓設計**:同代碼並發請求合併(僅 1 次上游呼叫)、每 IP 240 請求/分鐘限流、30 秒慢速請求超時、短效快取 7 天自動回收;DDoS 防護建議前置 Cloudflare(教學見 DEPLOY.md 第 8 步)。

## 會計模型(V3.1 定案:原始價 + 內部現金流轉)

- **計價**:個人組合 NAV/TWR/MWR/陰陽燭一律用**原始價**(拆股已調整、股息未調整);大盤基準對比唯一允許用**經調整價**(代表總報酬)。
- **自動股息**:除淨日按各資產位置持股自動入帳,`稅後 = 持股 × 每股息 × (1−預扣稅率)`;稅率取逐筆修改值 → 全局設定 → 0%。自動筆標記 ⚡,修改即轉手動、刪除入跳過清單;同代碼 ±14 天去重。除淨日股價跌、現金升,NAV 恆等平滑,不計外部資金流。
- **拆股**:交易單位數重述(單位×F、單價÷F,F=交易日後拆股比例累乘),用戶紀錄不被改寫;NAV 與成本均不跳動。
- **期權**:不入歷史曲線與 TWR/MWR;現金進出視為外部資金流(完全中立),列表以最後結算價靜態估值;圖表顯示「曲線不含期權現值 ±X」。
- **FEE / LIABILITY**:內部支出,減現金、不入資金流,自然壓低回報率;TWR 公式為 V₁/(V₀+C),費用不重複扣減。
- **事件標註**:資產值曲線上以金點(Div)/藍方(Split)標記事件日,十字線停留顯示明細氣泡。

## 數據架構(v3.1)

借鏡 Ghostfolio 與 Portfolio Performance 的設計:

**數據源備援鏈** — 每類數據都有主源與備源,單一服務故障不影響平台:

| 數據 | 主源 | 備源 | 最後手段 |
|---|---|---|---|
| 歷史價(含調整價+股息/拆股事件) | Yahoo Finance | 過期本地庫存 | Stooq(美/港/日,拆股已調整) |
| 匯率 | Yahoo {CCY}=X | 過期本地庫存 | Frankfurter / 歐洲央行(不含 TWD) |
| 代碼搜尋 | Yahoo | 前端內置 33 檔清單 | — |

**持久化 + 增量更新** — 歷史數據存於 `data/market/`,30 分鐘內直接回庫存;過期後只抓最後一根 K 線之後的缺口(帶兩週重疊修復窗),請求量比 TTL 全量重抓減少 95% 以上。若增量視窗內偵測到新的股息/拆股事件,因調整價會回溯變動,自動觸發全量重抓。

**股息/拆股事件** — `/api/history` 回應附 `dividends[]`、`splits[]`、`source`、`adjusted`、`stale` 欄位;前端據此顯示各持倉「近一年股息」估算。

**交易模型** — 買賣交易支援 `fee`(手續費,買入計入成本、賣出自現金扣除);新增「股息」「利息」交易類型,計入現金與報酬率但不視為外部資金流,TWR/MWR 因此反映含息全回報。

**自訂 JSONPath 數據源(#5)** — 借鏡 PP 的 JSON Quote Feed:在「個人中心 → 自訂數據源」提供任意 API 網址 + 日期路徑 + 價格路徑(JSONPath,支援 `$.a.b[*].c`、`['key']`、`[N]`),即可為任何基金/債券/理財產品接入歷史價,日期格式自動偵測(ISO、Unix 秒/毫秒、MM/DD/YYYY)。內建「測試」按鈕即時預覽解析結果;伺服器端有 SSRF 防護(拒絕內網位址)。自訂源在歷史價解析鏈中優先於 Yahoo。

**夜間排程預抓(#6)** — 伺服器每日於 `PREFETCH_HOUR`(預設台北 05:00,設 -1 停用)掃描全部用戶組合與自訂源,以 0.8 秒間隔禮貌性逐一更新,用戶白天打開即秒載。

**加密貨幣(#7)** — `BTC-USD`、`ETH-USD` 等代碼主源仍走 Yahoo;Yahoo 失敗時自動備援到 CoinGecko(免 API key)。

**CSV 匯入/匯出(#8)** — 「個人中心 → 交易紀錄 CSV」。匯出含全部欄位(kind/sym/ccy/loc/side/price/units/amount/fee/date);匯入支援本平台格式與 Ghostfolio 風格標頭(type/symbol/quantity/unitPrice/currency,DIVIDEND 列的 unitPrice×quantity 自動換算為金額),可選取代或合併。

## 即時數據來源

後端代理 Yahoo Finance 公開接口,前端按需載入:

| 數據 | 端點 | 覆蓋 | 快取 |
|---|---|---|---|
| 歷史日線(原始價 + 除權除淨經調整價) | `/api/history?symbol=` | 美股/ETF、港股 `.HK`、A股 `.SS`/`.SZ`、日股 `.T`、台股 `.TW` | 6 小時 |
| 匯率歷史(1 USD = ? CCY) | `/api/fx?ccys=HKD,JPY,...` | HKD/JPY/CNY/TWD/EUR/GBP | 6 小時 |
| 代碼搜尋(自動完成) | `/api/search?q=` | 全球,輸入 VT 即見 VT/VTI/... | 24 小時 |
| 持倉相關 + 熱門財經新聞 | `/api/news?symbols=` | Yahoo Finance 新聞 | 10 分鐘 |

頂欄會顯示「即時數據 / 模擬數據」狀態:
- 經 `http(s)://` 由本伺服器開啟 → 自動進入**即時數據**模式
- 直接雙擊開啟 `index.html`(`file://`)或後端不可達 → 自動退回**模擬數據**模式,介面照常運作
- 個別代碼抓取失敗(例如期權、已下市)→ 以最後成交價估值,不影響整體計算

## 帳號與同步

- 註冊/登入:`scrypt` 密碼雜湊 + Bearer token,改密碼會登出其他裝置
- 登入後交易紀錄與偏好設定自動同步到伺服器(`data/portfolios/`),換裝置登入即還原
- 訪客模式:數據只存本機,自動載入示範組合
- 前端輸入同一電郵:已註冊則登入,未註冊自動建立帳號

## 部署到公網

任何能跑 Node 的環境皆可:

**VPS(推薦搭配 pm2 與反向代理)**
```bash
npm i -g pm2
pm2 start server.js --name wealthlens
# 以 Nginx/Caddy 反代 8080 並掛上 HTTPS
```

**Render / Railway / Fly.io**:Build command 留空、Start command `node server.js`、
設定 `PORT` 由平台注入即可。

注意:Yahoo 為非官方公開接口,大流量或商業用途建議改接付費行情商
(Polygon、Twelve Data、EODHD 等)——只需改寫 `server.js` 中
`getHistory / getFx / searchSymbols / getNews` 四個函式,前端無需更動。

## 其他

- 限流:每 IP 每分鐘 240 個 API 請求
- 期權代碼(如 AAPL260618C200)無公開歷史源,以最後成交價估值
- TWR 採資金流切分鏈式相乘;MWR 為 XIRR(年化),均以經調整價計算
