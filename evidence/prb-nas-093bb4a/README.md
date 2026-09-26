# NAS 093bb4a：四案完成，NAS_ACCEPTANCE_FAIL

Run: https://github.com/Fyun48/5151/actions/runs/36251837874
受測 SHA：`093bb4ae76339b0f6a5f4ea57ca4266872de4a30`。
sourceSha／checkoutSha、14 個 module hashes、原始 SHA256SUMS 全核對相符。
Artifact 10909757016 ZIP SHA256：`9b0eff6c8d0afdc6999f4aae75a4033fe73116063025e89a5d5f3aa1ecd698d5`，已核對。
Workflow SHA：`e86b78b962731e8f45eef541f2bf2fafe002def5`。

CasaOS N3450，完整 120,000 rows／36,000 scope rows；暖機 5 輪、每案 50 次。

| 案例 | p95 ms | lag p99 / max ms | RSS MiB | errors / timeouts |
|---|---:|---:|---:|---:|
| 單區 C1 | 2136.93 | 33.36 / 95.16 | 397.2 | 0 / 0 |
| 單區 C4 | 5118.03 | 46.30 / 280.49 | 589.1 | 0 / 0 |
| 全區 C1 | 2161.05 | 37.39 / 98.96 | 580.0 | 0 / 0 |
| 全區 C4 | 5817.00 | 57.87 / 227.28 | 763.0 | 0 / 0 |

- 真 PG 162 tests／161 pass／0 fail／1 skip。新增的真 PG 整輪排他測試通過；包含獨立 pool 的第二個 worker 被阻擋、同 owner 交易共用連線、成功／失敗後釋放。
- benchmark sqliteAttempts=0；四案結果 hash 與 1e0813e／先前版本相同，200 次 errors／timeouts=0。
- 四案延遲均未達原門檻；兩個 C1 lag 通過，兩個 C4 lag 未過。原始 NAS_ACCEPTANCE_FAIL 保留。
- runner exit=1、cleanup-ok=true；container/network/volume 查詢均為 0。148 行資源取樣 JSONL 均可解析，無 EXIT 卡死。
- README、workflow-provenance 為下載後補充，不列入 NAS 產生的原始 SHA256SUMS。
- 這不是全站爬蟲精準度、跨節點業務或正式備份復原驗收；未合併、未部署應用程式。

## 退步來源與決策

相較 1e0813e，前三案較慢，全區 C4 較快；仍比 6703302 慢，不能稱為速度相近。
fixture 全域公式、完整筆數與既有計畫摘要比對已保存於前輪附件，無足夠證據指定退步根因。
除了程式／fixture，runner 已由串流改為反覆 `docker stats --no-stream` 取樣，診斷本身的額外成本也未隔離；不將此假說當成已證實原因。
不刪失敗樣本、不放寬原門檻、不再因 FAIL 自動觸發純效能修正迴圈。
維持 NOT_READY_FOR_REVIEW／NOT_READY_FOR_MERGE；後續聚焦既有資料同源與可復原要求，具體路徑見 [上線缺口](../../docs/handoffs/RELEASE_GAPS_093bb4a.md)。
