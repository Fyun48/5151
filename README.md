# 591 物件追蹤

官方電子報只能每天或每週寄一次，也無法標記「已瀏覽」、「特別關注」或「同屋源更新」。這個本機小工具會依你在 591 設好的搜尋條件定期檢查，把新刊登、改價、同一屋源重新上架分開處理，並依你的開關決定要不要通知。

## 功能

- 貼上 591 租屋搜尋結果網址（可多組）
- 全新物件、同屋源重新刊登、價格／標題變更分開標記
- 每筆可設「已瀏覽」「特別關注」
- 通知開關：全新物件、同屋源更新、已瀏覽過是否仍通知、特別關注是否一律通知
- Windows 桌面氣泡通知，可另填 Discord Webhook
- 第一次檢查只建立基準，避免把現有物件一次推完

同屋源是用地址、樓層、坪數、格局（以及社區編號，若有）組成指紋。591 列表沒有公開穩定的屋源 ID，偶有相近物件被判成同一屋源時，以畫面上的歷史為準即可。

## 使用

需要 Node.js 22 以上。線上追蹤只跑 v3。

```bash
npm install
npm run start:v3
```

瀏覽器開啟 http://127.0.0.1:5153

1. 到 [591 租屋](https://rent.591.com.tw/) 設好地區、租金、類型等條件，排序選「最新」
2. 複製網址，貼進左側「搜尋網址」
3. 勾選要接收的通知類型後按「儲存設定」
4. 按「立即檢查」建立基準；之後程式會依間隔自動檢查

請保持這個視窗在跑。檢查間隔建議 5 分鐘以上，且每次只抓最新 1–2 頁，避免對 591 造成負擔。此工具僅供個人找房使用。

## 版本

**v1／v2 已拆除。** Docker／CasaOS 只跑 v3。歷史目錄 `/DATA/AppData/591-tracker`（`591.db`）與 `/DATA/AppData/591-tracker-v2`（`v2.db`）可只讀掛給 v3 匯入。不要再用 `https://c5151.reversalplay.me/`。

**目前線上**是 `v3/`，埠 5153（5155 同一容器），資料 `data-v3/v3.db`。規劃見 `v3/ARCHITECTURE.md`。**之後新功能只做 v3**。畫面上的產品名仍是「吉比租房物件追蹤」。

公開網址：

- 目前版：`https://jibbyrenth.reversalplay.me` → `127.0.0.1:5153`（5155 同一台 v3），資料 `/DATA/AppData/591-tracker-v3`
- OPS：`https://jibbyrentops.reversalplay.me` → `127.0.0.1:5154`

同一個 GitHub repo、同一張 Docker 映像、同一條 Cloudflare Tunnel。不必新開 GitHub 專案。

Cloudflare Zero Trust → Networks → Tunnels → 現有 tunnel → Public Hostname：

1. Subdomain `jibbyrenth`，Domain `reversalplay.me` → Type `HTTP`，URL `http://127.0.0.1:5153`（5155 是同一容器別名）
2. Subdomain `jibbyrentops`，Domain `reversalplay.me` → Type `HTTP`，URL `http://127.0.0.1:5154`（OPS，獨立容器）
3. `a5151`／`b5151`／`c5151` 不再使用。

CasaOS 上 `docker compose up`／應用只跑 v3。第一次請停掉舊容器：

```bash
cd /mnt/Storage1/apps/5151
docker compose stop 591-tracker 591-tracker-v2 || true
docker stop 591-tracker 591-tracker-v2 || true
docker rm -f 591-tracker 591-tracker-v2 || true
mkdir -p /DATA/AppData/591-tracker-v3
docker compose up -d --no-build --no-deps 591-tracker-v3
```

推 `v3/src`、`v3/public` 或 compose 檔後，走 CasaOS 三步部署目前版。歷史庫只讀，不會被改寫。

## 部署到 CasaOS

SQLite 與設定會寫進 `DATA_DIR`（容器內預設 `/data`）。CasaOS 請用 bind mount 到 `/DATA/AppData/591-tracker-v3`，不要用 Docker 具名 volume，否則 CasaOS 重裝時資料容易不見。v1／v2 歷史目錄可留著給只讀匯入，但不要再當正式站資料目錄。

Linux 容器沒有 Windows 氣泡通知。預設用站內待看視窗與系統推播（PWA）。第一次若要鎖定畫面推播，可在資料目錄的 `auth.env` 放 `VAPID_PUBLIC_KEY`／`VAPID_PRIVATE_KEY`；沒填時容器會自行寫入 `vapid.json`。郵件與 Discord Webhook 仍是選用。

Cloudflare Zero Trust 請為目前版加 Public Hostname：`jibbyrenth` → `http://127.0.0.1:5153`。OPS 為 `jibbyrentops` → `http://127.0.0.1:5154`。同一條 tunnel，不要另開第二條。不要再用 `c5151`。

### 方式一：CasaOS 匯入 Compose（建議，拉 GitHub 映像）

1. 等 GitHub Actions 把映像推到 `ghcr.io/fyun48/5151:latest`
2. CasaOS → 應用 → 安裝自訂應用 → 匯入 `casaos-compose.yml`
3. 若 repo 是 private，先在 CasaOS 終端登入：

```bash
echo YOUR_GITHUB_TOKEN | docker login ghcr.io -u YOUR_GITHUB_USER --password-stdin
```

Token 需要 `read:packages`。公開 repo 通常不必登入。

主服務是目前版（埠 5153，別名 5155）。v1／v2 不會啟動。

瀏覽器開 `http://<CasaOS IP>:5153`（本機埠只綁 loopback，一般走下方公開網址）。

推到 `master` 後，GitHub Actions 會建 `ghcr.io/fyun48/5151:latest`。CasaOS 上的 Watchtower 約每 2 分鐘檢查一次，有新映像就自動換上；SQLite 資料仍在各版的 AppData 目錄。

### 方式二：在 CasaOS 上 clone 後拉映像

```bash
cd /mnt/Storage1/apps/5151
git pull
docker compose --profile tunnel up -d
```

第一次請用映像 `ghcr.io/fyun48/5151:latest`，不要再 `--build`。之後推 GitHub 即可。

### 從本機帶走已標記資料

若要把 Windows 上的「已瀏覽 / 特別關注 / 隱藏」一起帶走，把本機資料庫複製到對應版的 CasaOS 目錄（容器停止時再複製較保險）。v1 歷史庫是 `/DATA/AppData/591-tracker/591.db`。

公開網址：

- 目前版：`https://jibbyrenth.reversalplay.me` → `http://127.0.0.1:5153`
- OPS：`https://jibbyrentops.reversalplay.me` → `http://127.0.0.1:5154`

CasaOS 本機埠只綁 loopback。
