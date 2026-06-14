# WealthLens VPS 部署教學(由零開始)

目標:在一台全新的 Ubuntu VPS 上,以網域 + HTTPS 正式上線 WealthLens,含反向代理、開機自啟、防火牆、郵箱驗證與備份。全程約 30–45 分鐘。

## 為什麼用 VPS,而不是 Netlify / Vercel / Serverless

WealthLens 的後端是一個**持久運行的 Node.js 伺服器**:需要長駐進程跑夜間預抓、用本機磁碟保存用戶與市場數據、維持記憶體快取與請求合併。Netlify / Vercel 免費方案本質是「靜態托管 + 短命 Serverless 函式」,**沒有持久磁碟、沒有長駐進程**,會讓這套架構失效;要硬上得整個改寫成「函式 + 外部資料庫 + 物件儲存」,不值得。

更重要的是**帳單風險**:Serverless 按用量計費,一旦被惡意刷流量/刷函式呼叫,帳單可能暴增(俗稱 "denial of wallet" 錢包攻擊)。

> ✅ **本方案刻意採用「固定月費 VPS」**:無論被打多少流量,帳單就是固定那幾美元,最壞情況是服務變慢或被暫停,**絕不會收到天價帳單**。這是成本可控的關鍵。

## 成本總覽(固定、可預測)

| 項目 | 費用 | 說明 |
|---|---|---|
| VPS(Hetzner / Vultr / DigitalOcean 最低配) | 約 US$4–6 / 月 | 固定月費,1 vCPU / 1GB RAM 足夠 |
| 網域 | 約 US$10 / 年 | |
| Cloudflare(免費版) | $0 | DDoS 防護 + 隱藏真實 IP |
| Let's Encrypt 憑證 | $0 | Caddy 自動申請續期 |
| **合計** | **約每月 5–6 美元,封頂** | |

## 安全與資料保護總覽(多層防禦)

1. **Cloudflare 免費版(主力)**:流量型 DDoS 在到達 VPS 前被吸收;隱藏真實 IP;可開啟速率限制與「Under Attack」模式(第 8 步)。
2. **VPS 防火牆 + SSH 金鑰登入**:只開 80/443/SSH,關閉密碼登入(第 1 步)。
3. **應用層**(程式已內建):每 IP 240 請求/分鐘限流、2MB 請求體上限、30 秒慢速請求超時、自訂源 SSRF 防護。
4. **HTTPS 全程加密**:Caddy 自動 TLS(第 5 步)。
5. **電郵驗證**:防垃圾註冊(第 6 步)。
6. **用戶資料**:密碼以 scrypt 加鹽雜湊(不存明文);每日自動備份並加密(第 7 步)。

> ⚠️ **法律提醒**:一旦收集真實用戶的 email 與財務資料,即涉及個資法規(視用戶所在地,如歐盟 GDPR、香港 PDPO),需備妥隱私政策與資料刪除機制。商業上線前請諮詢當地律師。

**事前準備**
1. 一台 VPS(任選 Vultr / DigitalOcean / Linode / Hetzner / 阿里雲輕量等;1 vCPU / 1GB RAM / 25GB SSD 的最低配即可,月費約 US$4–6)。建立時選 **Ubuntu 24.04 LTS**,區域選離你近的(香港/東京/新加坡)。
2. 一個網域(如 `example.com`,年費約 US$10)。到網域商的 DNS 設定加一筆 **A 記錄**:主機名 `app`(或 `@`),指向 VPS 的 IP。等幾分鐘讓 DNS 生效(用 `ping app.example.com` 確認回應的是你的 IP)。

---

## 第 1 步:首次登入與基本安全

用 VPS 商提供的 root 密碼 SSH 登入(Windows 用 PowerShell 或 Termius,macOS 用「終端機」):

```bash
ssh root@你的VPS_IP
```

建立日常用的帳號並給予 sudo 權限(不要長期用 root):

```bash
adduser deploy            # 按提示設密碼,其餘直接 Enter
usermod -aG sudo deploy
```

開啟防火牆,只放行 SSH 與網頁連接埠:

```bash
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw enable                # 問 y/n 時按 y
```

之後改用新帳號登入:

```bash
exit
ssh deploy@你的VPS_IP
```

### SSH 金鑰登入加固(強烈建議)

密碼登入是暴力破解的主要入口。改用金鑰登入並關閉密碼:

```bash
# 在「你的電腦」產生金鑰(若已有可跳過)
ssh-keygen -t ed25519 -C "wealthlens"
# 把公鑰複製到 VPS
ssh-copy-id deploy@你的VPS_IP
```

確認能用金鑰登入後,在 VPS 上關閉密碼登入:

```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

再裝 fail2ban 自動封鎖反覆嘗試的 IP:

```bash
sudo apt-get install -y fail2ban
sudo systemctl enable --now fail2ban
```

## 第 2 步:安裝 Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v        # 應顯示 v20.x
```

## 第 3 步:上傳專案

方法 A——從你的電腦直接上傳 zip(在**你電腦**的終端機執行):

```bash
scp wealthlens-fullstack.zip deploy@你的VPS_IP:~
```

回到 VPS:

```bash
sudo apt-get install -y unzip
unzip wealthlens-fullstack.zip
cd wealthlens
node server.js             # 試跑,看到 listening on http://localhost:8080 即成功
# Ctrl+C 停止,下一步改用 pm2 常駐
```

(方法 B:若代碼放在 git 倉庫,`sudo apt-get install -y git && git clone 你的倉庫網址` 即可。)

## 第 4 步:pm2 常駐與開機自啟

```bash
sudo npm install -g pm2
cd ~/wealthlens
pm2 start server.js --name wealthlens
pm2 save
pm2 startup                # 它會印出一行 sudo 開頭的指令 → 複製貼上執行一次
```

常用指令:`pm2 status`(狀態)、`pm2 logs wealthlens`(看日誌)、`pm2 restart wealthlens`(重啟)。

## 第 5 步:Caddy 反向代理 + 自動 HTTPS(推薦)

Caddy 會**自動申請並續期 Let's Encrypt 憑證**,設定只需三行,是新手最不易出錯的方案:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

編輯設定檔 `sudo nano /etc/caddy/Caddyfile`,整檔換成(網域改成你的):

```
app.example.com {
    reverse_proxy localhost:8080
    encode gzip
}
```

存檔(Ctrl+O、Enter、Ctrl+X)後重載:

```bash
sudo systemctl reload caddy
```

打開瀏覽器進入 `https://app.example.com` —— 完成,鎖頭已亮。

<details>
<summary>替代方案:Nginx + certbot(點開展開)</summary>

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo nano /etc/nginx/sites-available/wealthlens
```

內容:

```
server {
    listen 80;
    server_name app.example.com;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_http_version 1.1;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/wealthlens /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d app.example.com    # 按提示輸入 email,自動配置 HTTPS 與續期
```
</details>

## 第 6 步:啟用郵箱驗證註冊(可選)

不設定時,平台為「免驗證直接註冊」模式(適合自用)。要開放給他人註冊,建議啟用驗證:

到任一 SMTP 服務取得帳密(免費選項:Brevo 每天 300 封、Gmail 應用程式密碼、Zoho 等),然後:

```bash
pm2 delete wealthlens
SMTP_HOST=smtp-relay.brevo.com SMTP_PORT=465 \
SMTP_USER=你的SMTP帳號 SMTP_PASS=你的SMTP密碼 \
SMTP_FROM=noreply@example.com \
pm2 start server.js --name wealthlens --update-env
pm2 save
```

設定後,新用戶註冊須輸入寄到信箱的 6 位驗證碼(15 分鐘有效、60 秒重寄限速、錯 5 次鎖定)才能建立帳號。

> 注意:本系統 SMTP 走 **465 連接埠(隱式 TLS)**,選服務時請用 465 而非 587。

## 第 7 步:每日備份

所有用戶數據都在 `~/wealthlens/data/`。設定每日 4 點自動備份、保留 14 天:

```bash
crontab -e     # 第一次會問編輯器,選 nano
```

加入一行:

```
0 4 * * * tar czf ~/backup-$(date +\%F).tar.gz -C ~/wealthlens data && find ~ -name 'backup-*.tar.gz' -mtime +14 -delete
```

(更穩妥的做法是再把備份檔同步到對象儲存或另一台機器,例如以 `rclone` 上傳到任一雲端硬碟。)

**加密備份(若備份含真實用戶資料,強烈建議)**

未加密的備份等於把用戶資料明文留在磁碟,一旦備份檔被取走就全洩。用 GPG 對稱加密,只有持密碼者能還原。

**(1) 手動加密 / 還原(理解原理)**

```bash
# 備份並以密碼加密(互動式輸入密碼)
tar czf - -C ~/wealthlens data | gpg -c -o ~/backup-$(date +%F).tar.gz.gpg
# 還原:解密後解壓到 ~/restore
mkdir -p ~/restore
gpg -d ~/backup-2026-06-14.tar.gz.gpg | tar xzf - -C ~/restore
```

**(2) 自動化加密備份(每日,非互動式)**

cron 無法互動輸入密碼,因此把密碼放在一個「只有你讀得到」的檔案。先建立密碼檔:

```bash
# 設定一個強密碼存到受保護的檔案(只有你的帳號可讀)
echo '換成你自己的強密碼' > ~/.backup-pass
chmod 600 ~/.backup-pass
```

設定每日加密備份、保留 14 天:

```bash
crontab -e
```

加入一行(注意 `\%` 是 cron 對 `%` 的轉義):

```
0 4 * * * tar czf - -C ~/wealthlens data | gpg --batch --yes --passphrase-file ~/.backup-pass -c -o ~/backup-$(date +\%F).tar.gz.gpg && find ~ -name 'backup-*.tar.gz.gpg' -mtime +14 -delete
```

還原時(從密碼檔自動解密):

```bash
mkdir -p ~/restore
gpg --batch --passphrase-file ~/.backup-pass -d ~/backup-2026-06-14.tar.gz.gpg | tar xzf - -C ~/restore
```

**(3) 異地存放(避免主機與備份同毀)**

把加密後的 `.gpg` 檔同步到另一處(雲端硬碟、物件儲存、另一台機器)。因為檔案已加密,放在第三方也安全。例如用 `rclone`:

```bash
# 一次性設定:rclone config 連結你的雲端(Google Drive / S3 / B2 等)
# 然後每日備份後上傳:
rclone copy ~/backup-$(date +%F).tar.gz.gpg remote:wealthlens-backup/
```

> ⚠️ **密碼遺失就永遠無法還原**——請把 `~/.backup-pass` 的密碼另外抄寫保存在安全的地方(如密碼管理器)。

> 用戶資料保護要點總結:密碼以 scrypt 加鹽雜湊儲存(`server.js` 不存明文)、每個用戶各自的鹽不同;傳輸由 HTTPS 加密;備份以 GPG 加密並異地存放;用戶可透過「我的 → 刪除帳號」自助永久刪除其全部資料(符合 GDPR/PDPO 的刪除權)。

## 第 8 步(強烈建議):前置 Cloudflare 抗 DDoS

1. 到 Cloudflare(免費方案即可)新增你的網域,按指示把網域的 NS 改到 Cloudflare。
2. DNS 記錄維持 A 記錄指向 VPS IP,**開啟橙色雲朵(Proxied)**。
3. SSL/TLS 模式選 **Full (strict)**。

之後所有流量先經 Cloudflare 全球網路清洗,常見的流量型 DDoS 在到達你的 VPS 前就被吸收;真實 IP 也被隱藏。應用層仍有內建的每 IP 限流(240 請求/分鐘)與慢速請求超時作第二道防線。

**建議再加的免費防護(Cloudflare 控制台):**

- **Rate Limiting Rule**:對 `/api/*` 設一條規則,例如「同一 IP 每分鐘超過 100 次請求就阻擋 1 分鐘」,擋住應用層刷量。
- **WAF Managed Ruleset**:免費方案即可開啟基本受控規則,擋常見攻擊樣式。
- **Bot Fight Mode**:開啟,擋自動化機器人。
- **Under Attack Mode**:平時關閉;一旦遭遇攻擊,一鍵開啟,對每個訪客做 JS 挑戰。
- **限制連入地區/封鎖可疑來源**:依需要設定。

**防繞過(重要)**:攻擊者若知道你的 VPS 真實 IP,可繞過 Cloudflare 直接打你。設定防火牆只允許 Cloudflare 的 IP 連入 80/443,把直連擋掉:

```bash
# 取得 Cloudflare IP 範圍並只放行這些來源連入 web 埠(SSH 維持你自己可連)
for ip in $(curl -s https://www.cloudflare.com/ips-v4); do sudo ufw allow from $ip to any port 443 proto tcp; sudo ufw allow from $ip to any port 80 proto tcp; done
sudo ufw delete allow 80
sudo ufw delete allow 443
sudo ufw reload
```

> 設定後,只有經 Cloudflare 的流量能到達你的網站;直連真實 IP 會被防火牆拒絕。

## 常見維運操作

| 操作 | 指令 |
|---|---|
| 更新代碼 | 上傳新 zip 解壓覆蓋(保留 `data/`)→ `pm2 restart wealthlens` |
| 看即時日誌 | `pm2 logs wealthlens --lines 100` |
| 看自訂源報警 | `cat ~/wealthlens/data/alerts.log` |
| 改預抓時間 | `PREFETCH_HOUR=5 pm2 restart wealthlens --update-env` |
| 查磁碟用量 | `du -sh ~/wealthlens/data/*` |
