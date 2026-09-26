# PR-B：在當前 PG 快照驗證完整候選內容

NAS 的完整 page 查詢需要重複解碼數萬筆、每筆 42 欄候選。先做請求內重用後，單區 C1 開發短測仍約 2.86 秒；此實驗重用「已確認相同版本的完整內容」，每次選擇與版本驗證仍由當前 PG Repeatable Read 交易執行。

## 正確性界線

- 沒有 search-key TTL、查詢結果 memo、永久角色或固定 asOf 快取。每次重新執行原 WHERE、參數與 ORDER BY，只把傳輸欄位換成 ID 與 xmin/ctid 版本。全候選保留，不加候選 LIMIT。
- 每次先執行完整 42 欄的 LIMIT 0，確認欄位與讀取權限。再讀取資料庫、role、server 位址／啟動時間、relation OID／relfilenode、XID epoch 與欄位 metadata，作為內容作用範圍。LIMIT 0 只檢查契約，沒有用於篩選或計數。
- 普通表且無 inheritance、partitioning、RLS，並具有整表 SELECT 才使用版本重用；其餘照原查詢取資料。未命中者在同一快照讀回全部 42 欄。必要資料缺失仍拋錯。
- 每個真實 PG pool 有獨立 store。最多 50,000 筆／64 MiB 的保守內容成本；超限淘汰或不存，不減少回傳資料。回傳新物件，呼叫端修改不會改到 store。非純量欄位不存。
- xmin 表示資料列版本，ctid 不是長期主鍵；主鍵仍是 post_id。版本與 relation/storage/schema/epoch 一起核對，更新、刪除、TRUNCATE、schema 切換與重建都不沿用不符的內容。舊快照與新快照可以交錯，命中必須符合各自實際查到的版本。
- 這項設計不重用裁決撤回的 PG search-key／table-existence TTL。當前交易沒有讀到某列，就不能從 store 把它加回結果。

參考：[PG 16 system columns](https://www.postgresql.org/docs/16/ddl-system-columns.html)、[transaction/snapshot information](https://www.postgresql.org/docs/16/functions-info.html)、[storage functions](https://www.postgresql.org/docs/16/functions-admin.html)。

## 驗證進度

`pg-candidate-content.test.js` 使用獨立 schema／角色，驗證暖讀、回傳物件修改、不同查詢範圍／日期、更新／新增／刪除／rollback、交錯快照、跨 schema、TRUNCATE、欄位替換／缺欄位、RLS 原路徑、權限撤回、欄位限定 SELECT、淘汰及超大列。原完整欄位 array 解碼測試保留。

- 版本重用第一版完整 PG 回歸：142 tests／141 pass／0 fail／1 optional skip。
- 隨後窄欄位批次依欄數調整、關係查詢改成既有索引可用的正負範圍：19 個針對性測試全過。
- NAS 三次開發短測：單區 C1 約 1.93 秒，結果 signature 與 baseline 相同，errors/timeouts 皆 0；每次 query count 49，lag p99 43.45／max 70.25 ms。這不是 50 次正式驗收，仍高於單區 1 秒門檻。
- 第一個冷請求約 4.21 秒，會多做版本驗證及首次完整填入；不能只報暖讀收益。正式 benchmark 已在每個案例前清空應用內容 store，保留每案冷請求，暖機至少 5 輪再量測 50 次。

工作持續進行，未 merge、未部署。下一步檢查完整候選的 cursor 計畫與重複的無作用篩選成本，之後執行同 SHA 完整四案 NAS 驗收。
