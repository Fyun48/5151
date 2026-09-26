# NAS 1e0813e：四案完成，原始 NAS_ACCEPTANCE_FAIL

Run: https://github.com/Fyun48/5151/actions/runs/36250785406
受測 SHA：`1e0813e14f3934fe6218065c054ac4f9cfd63261`。
sourceSha／checkoutSha 與 14 個 module hash 均核對 Git 中受測版本（不是尚未提交的 ownership 工作樹）。
Artifact 10908259856 ZIP SHA256：`b6ba7ac0ecab29ea14ffde882c13974d187ec4972afd21016ccf7399636cf8b8`，已驗證。
Workflow SHA：`e86b78b962731e8f45eef541f2bf2fafe002def5`。

CasaOS N3450，Node 22.23.3，PG 16.14；120,000 rows、36,000 active rows；暖機 5 次、每案 50 次。

| 案例 | p95 ms | lag p99 / max ms | RSS MiB | errors / timeouts |
|---|---:|---:|---:|---:|
| 單區 C1 | 1915.93 | 31.05 / 87.82 | 396.8 | 0 / 0 |
| 單區 C4 | 4812.84 | 47.55 / 295.44 | 606.7 | 0 / 0 |
| 全區 C1 | 2048.02 | 35.59 / 110.10 | 613.6 | 0 / 0 |
| 全區 C4 | 6267.02 | 58.49 / 275.78 | 749.4 | 0 / 0 |

- 真 PG 157 tests／156 pass／0 fail／1 skip，新增持久輪替、並行預約與跨輪會員完成測試在 NAS 真 PG 通過。
- 四案完整；200 次量測 errors／timeouts=0。單區 d75a57c20695…、全區 b1a872a9e9aa… 與先前結果 hash 相同。
- 四案延遲門檻皆未過；只有單區 C1 lag gate 通過。原始 NAS_ACCEPTANCE_FAIL 不改寫。
- runner exit=1；container/network/volume 標籤查詢全 0；144 行 JSONL 全可解析，無 EXIT 卡死。
- 原始 SHA256SUMS 全部驗證相符；README、workflow-provenance 與比較附件是後補，不在原始 manifest。
- 相較 92e8210，前三案較快、全區 C4 較慢；仍不能視為與先前已接受的 6703302 效能相近。
- 不以本 fixture 搜尋結果推論正式爬蟲來源精準度、跨節點一致性或備份復原已完成。未合併、未部署應用程式。

## fixture／計畫比對

比較附件 fixture-plan-comparison.json 為 6703302 對 92e8210 的 18 筆原始 EXPLAIN 摘要。
分批 INSERT 保持相同的 global i=1..120000、欄位公式、asOf 與完整筆數，兩版都在建完後 ANALYZE。
前後 Node／PG image ID 相同；18 筆所存 requestSnapshot 根節點種類／實際列數／loops 一致，部分 totalCost 約增加 2.35%，shared hit blocks 幾乎一致。
SQL 字串僅保存前綴，計畫只有根節點摘要，不能宣稱完整 plan tree、所有索引選擇或所有統計值完全相同。
目前沒有證據把整體退步歸因於 fixture 換計畫；也未完成受控主機負載對照，不指定根因。
狀態維持 NOT_READY_FOR_REVIEW／NOT_READY_FOR_MERGE，停止純效能微調，繼續必要正確性與復原工作。
