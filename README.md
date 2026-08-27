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

需要 Node.js 22 以上。

```bash
npm install
npm start
```

瀏覽器開啟 http://127.0.0.1:5151

1. 到 [591 租屋](https://rent.591.com.tw/) 設好地區、租金、類型等條件，排序選「最新」
2. 複製網址，貼進左側「搜尋網址」
3. 勾選要接收的通知類型後按「儲存設定」
4. 按「立即檢查」建立基準；之後程式會依間隔自動檢查

請保持這個視窗在跑。檢查間隔建議 5 分鐘以上，且每次只抓最新 1–2 頁，避免對 591 造成負擔。此工具僅供個人找房使用。

## 部署到 CasaOS

SQLite 與設定會寫進 `DATA_DIR`（容器內預設 `/data`）。CasaOS 請用 bind mount 到 `/DATA/AppData/591-tracker`，不要用 Docker 具名 volume，否則 CasaOS 重裝時資料容易不見。

Linux 容器沒有 Windows 氣泡通知，請在畫面填 Discord Webhook。

### 方式一：CasaOS 匯入 Compose（建議，拉 GitHub 映像）

1. 等 GitHub Actions 把映像推到 `ghcr.io/fyun48/5151:latest`
2. CasaOS → 應用 → 安裝自訂應用 → 匯入 `casaos-compose.yml`
3. 若 repo 是 private，先在 CasaOS 終端登入：

```bash
echo YOUR_GITHUB_TOKEN | docker login ghcr.io -u YOUR_GITHUB_USER --password-stdin
```

Token 需要 `read:packages`。公開 repo 通常不必登入。

資料目錄：`/DATA/AppData/591-tracker`（會出現 `591.db`）。

瀏覽器開 `http://<CasaOS IP>:5151`。

### 方式二：在 CasaOS 上 clone 後自行 build

```bash
cd /DATA
git clone https://github.com/Fyun48/5151.git
cd 5151
docker compose up -d --build
```

同樣把資料掛到 `/DATA/AppData/591-tracker`。

### 從本機帶走已標記資料

若要把 Windows 上的「已瀏覽 / 特別關注 / 隱藏」一起帶走，把本機 `data/591.db` 複製到 CasaOS 的 `/DATA/AppData/591-tracker/591.db`（容器停止時再複製較保險）。
