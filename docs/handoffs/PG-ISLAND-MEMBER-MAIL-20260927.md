# PG 島嶼遺漏：會員郵件 SMTP 設定（2026-09-27）

## 一句話

公開站「通知設定 → 自己的郵件 SMTP」整條路徑**只在 `db.js`（同步 SQLite）**，沒有 PG 版本，
所以它讀寫的是**回答那台節點自己的 SQLite**；實測同一台生產的兩個節點回**不同的答案**。

## 怎麼發現的

Owner 提供後台截圖後，我核對 PG 的值，發現與畫面不符。第一次我還看錯鍵——
`user_settings.memberSmtp` 是**會員層級**（這條路徑），`settings.smtp` 是**站台管理員**層級
（走 `auth.env`，那條正常）。兩者不同，先前的疑慮是我混淆造成的，已釐清。

## 證據（2026-09-27，正式站）

用**程式自己的函式** `getMemberMailSettings(1)` 在兩個容器內讀：

| 節點 | host 有值 | 帳號 | 寄件名稱 |
|---|---|---|---|
| CasaOS `591-tracker-v3`（web-A） | **否** | （空） | 吉比租房物件追蹤 |
| Synology `5151-web-B`（web-B） | **是** | `acefengyun@…` | **11**吉比租房物件追蹤 |

公開站經 HAProxy 在兩台之間輪流，所以**同一頁重新整理就會看到不同結果**。

### 全庫比對（md5，未印出任何密碼）

| user | key | CasaOS | Synology | PG | 判定 |
|---|---|---|---|---|---|
| 1 | `memberSmtp` | len 109 `38a2311b` | len 164 `2e00e1b7` | len 109 `38a2311b` | **唯一分歧** |
| 1 | `memberMailTemplates` | `16f05ba3` | `16f05ba3` | `16f05ba3` | 一致 |
| 1 | `mailPreset` | `0c0281e4` | `0c0281e4` | `0c0281e4` | 一致 |
| 2 | `memberSmtp` | `656b278f` | `656b278f` | `656b278f` | 一致 |
| 2 | `memberMailTemplates` | `16f05ba3` | `16f05ba3` | `16f05ba3` | 一致 |
| 2 | `mailPreset` | `0c0281e4` | `0c0281e4` | `0c0281e4` | 一致 |

## 為什麼這是 PG 島嶼的漏網之魚

- `getMemberMailSettings` / `saveMemberMailSettings` / `getMemberMailBundle`
  **只存在於 `db.js`**（同步），沒有 async/PG 版本。
- 路由 `server.js`（`GET/POST /api/member-mail`、`POST /api/member-mail/test`）直接呼叫同步版。
- **`watcher.js` 寄送會員通知時也吃 `getMemberMailBundle`**，所以「由哪一台寄」會影響用哪個帳號。
- 既有的 `pr-a-access-matrix-20260924.md` **沒有** `memberSmtp`／`memberMail` 字樣；
  它的「會員設定」那一列講的其實是**搜尋設定**（`settingsAsync`），把這條漏掉了
  ——是稽核本身的盲點，不是已知缺口。

## 修法

新增 `v3/src/memberMailAsync.js`，照既有 `*Async.js` 島嶼模式（純判斷留在
`siteMail.js`／`memberMail.js`，PG 只換「跑語句的人」）：

- PG 分支用 `repository/memberSettings.js` 的 `USER_SETTINGS_SQL` / `USER_SETTING_UPSERT_SQL`
  ＋ `pgSharedDriver` 的連線／交易；值一律 `JSON.stringify`（與 `db.js` 相同格式）。
- 接線：`server.js` 三條路由改為 await 非同步版（含 `/test` 的讀寫）；
  `watcher.js` 兩處 `getMemberMailBundle` 改為 `await getMemberMailBundleAsync`。

## 已分歧資料的處理

規則：**以實際在用的那一版為準**。Owner 的畫面顯示的是 Synology 那版（host 有值、
`acefengyun@gmail.com`、寄件名稱「11吉比租房物件追蹤」），所以把 Synology 的值寫進 PG。

遷移前後（只印雜湊，密碼從未出現在輸出或對話中）：

```
BEFORE pg_md5=38a2311bb0ac856780d8f1547ad4bff4 len=109
SOURCE sqlite_md5=2e00e1b7c4dcafc6aaa683686c384825 len=164
WROTE 已寫入 PG
AFTER  pg_md5=2e00e1b7c4dcafc6aaa683686c384825 len=164
MATCH=true
```

舊值可由 CasaOS 的 `/data/v3.db` 完整還原（md5 `38a2311b…`），所以這步可回復。

## 驗證

| | PG（新來源） | 本機 SQLite（舊來源） |
|---|---|---|
| CasaOS | host_set=**true** `2e00e1b7` | host_set=**false** `38a2311b` |
| Synology | host_set=**true** `2e00e1b7` | host_set=true `2e00e1b7` |

兩台從 PG 讀到**完全相同**的值；CasaOS 的本機 SQLite 仍是舊的，正好證明先前的差異來自來源不同。

`v3/test/member-mail-async.test.js`（9 項，毋需真 PG）：
PG 分支讀寫與值格式、preset 連帶寫入、uid=0 丟 401、driver 切換，
以及**兩條 parity 測試**（同一組資料餵 SQLite 與 PG，結果必須逐欄相同）。
已用變異測試確認非空：寫入不做 `JSON.stringify` → 2 項失敗；拿掉 driver 判斷 → 1 項失敗。

## 尚未處理

這條是**誤打誤撞**發現的。需要一次機械化盤點，找出所有「仍只呼叫同步 `db.js`」的正式路由，
而不是一條一條撞——見 `PG-ISLAND-INVENTORY-20260927.md`。
