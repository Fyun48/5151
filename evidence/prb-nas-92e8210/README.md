# NAS 92e8210：四案完成，NAS_ACCEPTANCE_FAIL

[Run 36248207780](https://github.com/Fyun48/5151/actions/runs/36248207780) 於 2026-09-26 22:32（Asia/Taipei）完成。
受測 SHA：`92e8210adbe362e98c79ba869d8bd65c99ddbfd2`；sourceSha／checkoutSha 相符，14 個 module hash 與 Git 受測程式相符。
Workflow SHA：`e86b78b962731e8f45eef541f2bf2fafe002def5`。
Artifact 10908521855 ZIP SHA256：`2149f92e513aa1c75102e0e99cee6da37ccb29024a99a930378b60071669362c`，已核對下載內容。

CasaOS N3450 / 4 CPU / 8 GB；Node 22.23.3、PG 16.14；完整 120,000 rows、36,000 active rows；暖機 5 次，每案 50 次。

| 案例 | p95 ms | lag p99 / max ms | RSS MiB | errors / timeouts | 相對 6703302 p95 |
|---|---:|---:|---:|---:|---:|
| 單區 C1 | 2402.70 | 35.49 / 117.64 | 396.8 | 0 / 0 | 1.80× |
| 單區 C4 | 6040.11 | 59.02 / 358.61 | 563.0 | 0 / 0 | 1.99× |
| 全區 C1 | 3096.85 | 39.22 / 190.19 | 558.1 | 0 / 0 | 2.33× |
| 全區 C4 | 6080.45 | 63.31 / 238.42 | 779.9 | 0 / 0 | 1.72× |

## 核對結果

- 真 PG 155 tests／154 pass／0 fail／1 skip；四案完整，200 次量測 errors／timeouts 皆 0。
- 單區與全區 resultSignature 分別為 d75a57c20695…、b1a872a9e9aa…，與 6703302 完全一致；每案 expected 的筆數與前 50 個 ID 驗證通過。
- 四案 latency 與 lag hard gate 皆未過。保留 NAS_ACCEPTANCE_FAIL，不把 CI 或舊 SHA 的數值代入。
- runner exit=1；container/network/volume 三項標籤查詢皆 0；cleanup-ok=true。
- 174 行 postgres-resource-stats.jsonl 全部可解析、無 ANSI 刷新碼；EXIT 卡死未重現。
- 原始 SHA256SUMS 全部相符；README／workflow-provenance.txt 是下載後補充，不在原始 manifest 內。
- fixture 分批修復已實機通過，本輪不是 setup timeout。未合併、未部署應用程式。

## 效能判讀與範圍

此次 p95 比 Owner 先前接受的 6703302 慢 1.72～2.33 倍，不能稱「速度沒有差太多」。不擅自把既有效能例外擴大到本輪結果。
查詢數維持單區 88、全區 96，交易語句數未增加；受查 14 module 中僅 db.js／dbDriverPostgres.js 與 6703302 不同，搜尋核心未改。
SQL、stats、profile、sort 等多階段廣泛變慢，包含純同步計算；部分空閒 SELECT 1 往返也增加。這些觀測不足以判定是負載、CPU 降頻、I/O、GC 或程式改動造成，缺少同時段主機負載及受控對照，不指定根因。
本輪不因此啟動 GC／查詢純效能迭代；保留問題並優先完成爬蟲輪替／成功完成範圍、跨節點業務一致與備份復原。正式爬蟲來源精準度與吞吐不能由本 fixture 搜尋驗收推得。

狀態維持 NOT_READY_FOR_REVIEW／NOT_READY_FOR_MERGE / RELEASE_BLOCKED_ON_CORRECTNESS_AND_RECOVERY。
