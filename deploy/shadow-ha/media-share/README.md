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

## 回退

1. 三份 compose 各刪掉那兩行 → 重建容器（回到各節點本機目錄；原本的檔案都還在，未被刪除）。
2. casa：`umount /mnt/5151-media`、刪掉 `/etc/fstab` 的那一行、停用 timer。

## 已知限制

- Synology 是唯一實體來源：它關機時 casa 的媒體讀寫會失敗（`soft`+`retrans` 讓它快速失敗而非卡死）。
  但 syn 同時是 PG primary，屬既有單點，未因此變差。
- 走 NFS 的寫入速度受網路影響（本機 1GbE、目前媒體量 1.1MB，無感）。
- Synology 會在共享目錄建立 `@eaDir`：不影響程式（媒體一律以 `^[a-f0-9]{32}...` 檔名比對，
  且不做目錄列舉），只是 `ls` 時會看到。
