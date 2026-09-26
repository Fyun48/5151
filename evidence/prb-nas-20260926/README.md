# PR-B NAS 同 SHA 驗收（2026-09-26）

結論：**NAS_ACCEPTANCE_FAIL / NOT_READY_FOR_MERGE**。未合併、未部署。
保留第一次完成四案的 NAS 原始量測；沒有調整門檻或刪除失敗樣本。

- 受測程式 SHA：848aa7e4f32d9e4538ca290dfa28e809464ee70a。
- 主機：CasaOS，Intel Celeron N3450 @ 1.10GHz，8 GB RAM。
- 執行環境：Node v22.23.3；PostgreSQL 16.14。映像 ID 另存。
- 執行該 SHA 的 v3/scripts/prb-nas-verify.sh，使用新 checkout、PG volume、internal network；沒有發布 host port。
- 透過既有 code-server／共享 SSH 設定與 known_hosts 連入，保留 StrictHostKeyChecking。
- PG fixture 只寫入隔離的 tracker_prb_test；正式 5151_shadow 未作為測試資料庫。
- 真 PostgreSQL：130 tests／129 pass／0 fail／1 optional skip。
- 固定 fixture：120,000 stored／36,000 active；每案暖機後 50 次完整 page、stats、JSON。
- 本次證據提交不變更應用程式；測試結果歸屬上列受測 SHA。

## NAS 實測

| 案例 | p95 ms | 目標 ms | lag p99／max ms | peak RSS MiB | errors／timeouts | 結果 |
|---|---:|---:|---:|---:|---:|---|
| 單區 C1 | 4628.58 | 1000 | 43.78／109.12 | 375.5 | 0／0 | FAIL |
| 單區 C4 | 13857.82 | 2000 | 79.69／190.97 | 818.2 | 0／0 | FAIL |
| 全區 C1 | 4700.29 | 2000 | 32.72／203.82 | 776.8 | 0／0 | FAIL |
| 全區 C4 | 14200.41 | 4000 | 114.69／280.49 | 1011.3 | 0／0 | FAIL |

lag 門檻為 p99 ≤50 ms、max ≤100 ms。CI_SMOKE_PASS 不能取代 NAS gate。
獨立預期的 matched／total／dbTotal／前 50 筆 ID 與結果 hash 皆由 benchmark 驗證；完整 cold／warm、SQL 計數、EXPLAIN、moduleHashes 見 JSON。

## 下一個修正焦點

單區 C1 各階段 p95（各自取樣，不能相加當作整體 p95）：

| 階段 | p95 ms |
|---|---:|
| stats_ms | 2049.74 |
| sql_ms | 1223.00 |
| prepare_ms | 742.00 |
| preload_ms | 193.00 |
| profile_ms | 124.00 |
| sort_ms | 108.00 |
| relations_ms | 90.00 |
| display_ms | 77.00 |
| hydrate_ms | 24.00 |
| preload_page_ms | 18.00 |

listingSearchPage.js 先執行清單搜尋，再呼叫 listingStatsAsync.js；統計 repository 再載入候選並於 Node 計算。量測支持優先處理統計與候選搬移／處理成本。
下一步需在同一快照內減少重複候選載入，或將可等價計算的統計下推 PG；保留個人 flags、跨區關係、主副卡、全域排序與分頁一致性。
不得以候選 LIMIT、固定 fixture 快取、放寬門檻或略過 SQLite guard 達標。修正後需重跑 NAS 四案。

## 剩餘範圍

PR-B 尚未通過 NAS 效能驗收。C（排程／擁有權／AbortSignal）、D（match／eval）、E（其餘 domain）、F（全業務 SQLite 退出／PITR）與雙節點 E2E／HA／還原演練仍未完成。
搜尋核心零 SQLite 不等於整個應用已移除 SQLite。

## 原始證據

- prb-search-benchmark.json：四案完整量測、獨立預期、結果 hash、module hash、EXPLAIN。
- performance.log、pg-tests.log：原始測試輸出。
- node-image.txt、postgres-image.txt：受測映像 ID。
- runner-exit.txt：隔離驗收腳本結束碼。
- cleanup.txt：本次 runner 專屬容器、network、volume 清理確認。
- SHA256SUMS：此目錄證據校驗碼（不包含校驗碼檔本身）。
