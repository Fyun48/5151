# 5151 媒體共享儲存（member-media／self-photos）

2026-09-24 上線。目標：讓 web-A／web-B／正式站三個節點看到**同一份**會員媒體檔案，
關掉 web 層 HA 的最後一個破口（上傳在 A、從 B 讀會 404）。

## 架構

```
Synology（syn-nas 192.168.0.220）
  /volume1/5151-media/{member-media,self-photos}      ← 唯一實體來源（NFS export）
      │
      ├─ web-B（同機，直接 bind 本機路徑）
      │
      └─ NFS（vers=3, soft, timeo=50, retrans=2, sec=sys）
            └─ casa（192.168.0.140）掛在 /mnt/5151-media
                  ├─ 591-tracker-v3（正式站）bind /mnt/5151-media/member-media → /data/member-media
                  └─ 5151-web-A           bind 同上
```

程式不需要改：`memberMedia.js`／`selfPhotos.js` 都是 `path.join(DATA_DIR, "member-media"|"self-photos")`，
所以只要把共享目錄**疊在 `/data` 的子目錄上**即可。

## 三份 compose 的變更（各加兩行）

| 檔案 | 加入的掛載 |
|---|---|
| `docker-compose.yml`（正式站，repo 根目錄；deploy 會 SCP 到 NAS） | `${V3_MEDIA_ROOT:-/mnt/5151-media}/member-media:/data/member-media`（同 self-photos） |
| `deploy/shadow-ha/web/web-a/docker-compose.yml` | `/mnt/5151-media/member-media:/data/member-media`（同 self-photos） |
| `deploy/shadow-ha/web/web-b/docker-compose.yml` | `/volume1/5151-media/member-media:/data/member-media`（同 self-photos，**兩個 service 都要**） |

> ⚠️ 正式站的 compose 由 `deploy-v3.yml` 從 repo 覆蓋到 NAS（`appleboy/scp-action`），
> 所以**一定要改 repo 版**，只改 NAS 上的檔案會在下次發版被蓋掉。

## DSM 設定（一次性，Owner 操作）

1. 控制台 → 共用資料夾 → 新增 `5151-media`（volume1），權限給 `tori` 讀寫。
2. 共用資料夾 → `5151-media` → 編輯 → **NFS 權限** → 新增：主機 `192.168.0.140`、權限**讀取/寫入**、
   Squash **對應到管理員**、安全性 **sys**、非特權埠**不勾**、允許子資料夾**不勾**。
3. 控制台 → 檔案服務 → NFS → 啟用（本機的 `nfsd` 已在跑，通常已啟用）。

## casa 端的持久掛載

`/etc/fstab`：

```
192.168.0.220:/volume1/5151-media /mnt/5151-media nfs nfsvers=3,soft,timeo=50,retrans=2,_netdev,nofail 0 0
```

## 掛載守護（`mount-guard.sh` + systemd timer）

Docker 的 bind mount 在掛載變動後仍指向舊目錄 → NFS 斷線又重掛時，容器會繼續寫本機空目錄
（靜默分歧）。守護程式每 2 分鐘檢查一次，未掛載時：**先救出本機檔案 → 重掛 → 把檔案送回共享 →
重建容器**。安裝（casa）：

```bash
install -m 755 mount-guard.sh /usr/local/bin/5151-media-mount-guard.sh
install -m 644 5151-media-mount-guard.service /etc/systemd/system/
install -m 644 5151-media-mount-guard.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now 5151-media-mount-guard.timer
```

## 驗收（2026-09-24 實測）

| 項目 | 結果 |
|---|---|
| casa 掛載＋寫入 | NFS 掛起、marker 可讀、寫入 OK |
| web-B 重建後 | 容器內看到 11 個媒體檔（9＋2）＋ sentinel |
| web-A 重建後 | 同上，且 sentinel **經 NFS** 可見 |
| 正式站重建後 | 同上，掛載清單含兩個新 bind |
| **跨主機端到端** | 用 App 的 `saveSelfPhoto` 在 **web-A 寫入** → **web-B 讀到 `found:true`**（共享目錄檔案擁有者 `admin`，符合 Squash 規則） |
| 媒體 metadata | 三台 `listMemberMediaFor(1)` 結果一致（`media_count:3`、`tag_count:2`，`driver=postgres`）— 資料表本就走 PG，不是孤島 |
| 公開站 | 重建過程中與完成後皆 200（重建 web-A／web-B 時由另一台承接） |

## Cloudflare R2（CDN 直送；2026-09-24 起可選）

除了上面「三個節點共享同一份檔案」之外，會員素材庫的**公開顯示檔**可以再交給 Cloudflare R2，
由 CDN 直接送給瀏覽器（位元組不經過 NAS）。開關是 `MEDIA_SERVE=local|r2`，**預設 `local`＝行為完全不變**。

### 規則（資安與著作權）

| 檔案 | 去哪裡 | 原因 |
|---|---|---|
| `member-media/<hash>.jpg`（已浮水印顯示圖） | **R2 → CDN 直送** | 本來就是給人看的圖 |
| `member-media/<hash>_t.jpg`（縮圖） | **R2 → CDN 直送** | 同上 |
| `member-media/<hash>_o.jpg`（未浮水印原圖） | **只在本機** | 程式刻意標記不對外；`r2KeyForMemberMedia()` 對它一律回空字串 |
| `self-photos/<hash>.(jpg\|png\|webp)`（身分自拍） | **只在本機** | 敏感個資 |
| 591 等外部平台的物件圖（`listings.cover`） | **維持外連** | 不重製他人內容（2026-09-24 決策） |

- **寫入**：`local` 模式只寫本機；`r2` 模式「R2 ＋ 本機」雙寫，R2 失敗＝整筆失敗（寧可請使用者重試，
  也不要出現「DB 有、CDN 沒有」的圖）。本機那份同時是備援。
- **讀取**：`r2` 模式下 `/media/lib/:file` 以 **302 導向 CDN**（302 帶 5 分鐘快取、路徑以 `.jpg` 結尾
  → Cloudflare 會快取這個轉址，只有第一次回到源站）。URL 格式不變，因此擁有權檢查
  （`ownsMediaUrl`）、`isMemberMediaUrl`、listing 儲存與通知信都不必改。
- **快取**：CDN 物件 `cache-control: public, max-age=604800`（7 天）。刪除／重新浮水印後會**主動清除
  CF 快取**（需要 `R2_PURGE_TOKEN`，僅 Cache Purge 權限）；即使清除失敗，最慢 7 天自然失效。
- **回退**：把 `MEDIA_SERVE` 改回 `local` 並重建容器即可（本機檔案一直都在，圖片不會掉）。

### 需要的環境變數（`MEDIA_SERVE=r2` 時）

| 變數 | 說明 |
|---|---|
| `MEDIA_SERVE` | `r2` 或 `local`（預設） |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 的 S3 憑證（`/home/cline/.secrets/cloudflare/r2.env`） |
| `R2_BUCKET` | `5151-media` |
| `R2_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` |
| `R2_MEDIA_DOMAIN` | `https://media.reversalplay.me`（自訂網域 → CNAME `public.r2.dev`，proxied） |
| `R2_ZONE_ID` / `R2_PURGE_TOKEN` | 選擇性；有設才會主動清快取（權杖只有 Cache Purge 權限） |

⚠️ **不能放進 `.env`**：`deploy-v3.yml` 每次發版都會用 `printf … > .env` 覆寫 web 節點的 `.env`。
web-A／web-B 請寫在**主機 compose 的 `environment:`**（發版不會覆寫 compose）；正式站寫在
`/mnt/Storage1/apps/5151/.env`（發版會覆寫 compose，但**不動 `.env`**）。

### 上線狀態（2026-09-24，PR #480）

**已上線**：三節點都設 `MEDIA_SERVE=r2`，程式（`v3/src/media/*` ＋ `memberMedia.js`）隨發版 `d50dbcc`
（image digest `sha256:43b188ed…`）到位。設定位置：web-A／web-B 寫在**主機 compose 的 `environment`**、
正式站寫在 `/mnt/Storage1/apps/5151/.env`（皆已備份 `.bak-20260924-r2`）。

實查驗收：

| 項目 | 結果 |
|---|---|
| 三容器環境 | `MEDIA_SERVE=r2`、`R2_BUCKET=5151-media`、`R2_MEDIA_DOMAIN=https://media.reversalplay.me` |
| 公開顯示檔 | `/media/lib/<hash>.jpg` → **302** 至 `https://media.reversalplay.me/member-media/<name>` |
| 未浮水印原圖 | `/media/lib/<hash>_o.jpg` → **404**（且 R2 上不存在） |
| 自拍照 | 仍由本機提供；R2 上**不存在** |
| 既有檔案遷移 | 6 個公開顯示檔已上傳（`_o.jpg` 3 個略過），CDN `MISS → HIT` |
| 公開站 | `https://jibbyrenth.reversalplay.me/` → **200** |

### 實測（2026-09-24）

- R2 物件：`PUT 200`、`HEAD 200`、`DELETE 204`、刪除後 `HEAD 404`
- CDN：`cf-cache-status` 第一次 `MISS`、之後 `HIT`；`cache-control: public, max-age=604800`
- 清除快取：`POST /zones/<id>/purge_cache` → `success: true`

## 回退

1. 三份 compose 各刪掉那兩行 → 重建容器（回到各節點本機目錄；原本的檔案都還在，未被刪除）。
2. casa：`umount /mnt/5151-media`、刪掉 `/etc/fstab` 的那一行、停用 timer。

## 已知限制

- Synology 是唯一實體來源：它關機時 casa 的媒體讀寫會失敗（`soft`+`retrans` 讓它快速失敗而非卡死）。
  但 syn 同時是 PG primary，屬既有單點，未因此變差。
- 走 NFS 的寫入速度受網路影響（本機 1GbE、目前媒體量 1.1MB，無感）。
- Synology 會在共享目錄建立 `@eaDir`：不影響程式（媒體一律以 `^[a-f0-9]{32}...` 檔名比對，
  且不做目錄列舉），只是 `ls` 時會看到。
