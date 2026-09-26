# NAS 4ee81e7：測試資料建立逾時，四案未執行

Run: https://github.com/Fyun48/5151/actions/runs/36247562272
受測 SHA：`4ee81e7495f63873e302a6451b1bdc51a46cca16`。
Workflow SHA：`e86b78b962731e8f45eef541f2bf2fafe002def5`。
Artifact 10907977001 ZIP SHA256：`b296a3a485fc1f7c399fe271eaa1dfcac94b3630ea21aae9025b1d8ba7dc7838`，下載後核對相符。

## 核對結果

- sourceSha／checkoutSha 一致；14 個 module hash 與受測程式相符。
- CasaOS Intel Celeron N3450、Node 22.23.3、PG 16.14。
- 真 PG 155 tests／154 pass／0 fail／1 skip，包含取消後回滾。
- benchmark `status=FAILED`、`cases=[]`；錯誤 57014 / canceling statement due to statement timeout。
- 堆疊定位 benchmark.mjs 第 51 行的 120,000-row INSERT，發生於測量開始前；沒有四案延遲、結果 hash 或 sqliteAttempts 可供本輪判定。不能寫成效能門檻 FAIL，更不能套用舊 SHA 成績。
- runner exit=1 已正常產生；container/network/volume 標籤查詢皆 0；cleanup-ok=true。取樣器收尾沒有重現原來的卡死。
- postgres-resource-stats.jsonl 的 39 行皆可解析 JSON，無 ANSI 刷新碼。
- 原始 SHA256SUMS 全數核對相符並保留；README 與 workflow-provenance.txt 是下載後補充，不在原始 manifest 內。

## 處置

只將測試 fixture 的單一巨量 INSERT 改成每批 10,000 筆，完整保留 120,000 筆及 36,000 scope、全域 i 值與欄位公式，並檢查最終筆數。不放寬 15 秒語句逾時、不減少候選、不改效能門檻。新提交須先等精確 SHA CI，再重跑 NAS。

此次結果是 FIXTURE_SETUP_TIMEOUT / NAS_FOUR_CASES_NOT_RUN。既有搜尋效能例外仍有效，但不涵蓋未量測的新 SHA。未合併或部署應用程式。
