# WealthLens VPS 部署教學(由零開始)

目標:在一台全新的 Ubuntu VPS 上,以網域 + HTTPS 正式上線 WealthLens,含反向代理、開機自啟、防火牆、郵箱驗證與備份。全程約 30–45 分鐘。

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

> 進階(建議但非必須):設定 SSH 金鑰登入後,編輯 `/etc/ssh/sshd_config` 將 `PasswordAuthentication` 改為 `no`,再 `sudo systemctl restart ssh`,可大幅降低暴力破解風險。

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

## 第 8 步(強烈建議):前置 Cloudflare 抗 DDoS

1. 到 Cloudflare(免費方案即可)新增你的網域,按指示把網域的 NS 改到 Cloudflare。
2. DNS 記錄維持 A 記錄指向 VPS IP,**開啟橙色雲朵(Proxied)**。
3. SSL/TLS 模式選 **Full (strict)**。

之後所有流量先經 Cloudflare 全球網路清洗,常見的流量型 DDoS 在到達你的 VPS 前就被吸收;真實 IP 也被隱藏。應用層仍有內建的每 IP 限流(240 請求/分鐘)與慢速請求超時作第二道防線。

## 常見維運操作

| 操作 | 指令 |
|---|---|
| 更新代碼 | 上傳新 zip 解壓覆蓋(保留 `data/`)→ `pm2 restart wealthlens` |
| 看即時日誌 | `pm2 logs wealthlens --lines 100` |
| 看自訂源報警 | `cat ~/wealthlens/data/alerts.log` |
| 改預抓時間 | `PREFETCH_HOUR=5 pm2 restart wealthlens --update-env` |
| 查磁碟用量 | `du -sh ~/wealthlens/data/*` |
