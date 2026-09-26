# 5151：SQLite 正式環境退場、搜尋修復與 PG／HA 收斂執行指令

日期：2026-09-24  
對象：DeepSeek／Cline 執行代理；Jimmy 為 Owner；ChatGPT 負責最終獨立審查。  
Repository：Fyun48/5151。  
審查基準 commit：9c6b7b04f9801717cb6696e8e095fde4c309473f。  
本次 GitHub compare 結果：該 commit 與 master identical，ahead／behind 均為 0。此為審查當下結果；開始實作前請記錄新的 base SHA。

## 0. 給 DeepSeek 的總指令

請接續既有成果，完成本文件要求的程式修正、資料補遷工具、測試、部署前檢查及交接證據，再一次彙整回報 ChatGPT。不要每完成一個小項目就停下詢問下一步；已完成且有證據的工作沿用，只補缺口。

**結論：目前不能宣告「SQLite 已退場」或「公開站完整 HA 已驗收」。已確認的問題包含正式資料讀寫仍依賴節點 SQLite，而且搜尋與抓取控制流程存在額外缺口。**

執行順序：保存各節點既有資料與建立可追蹤清單 → 修復訪客／會員搜尋的資料來源與投影完整性 → 收斂抓取狀態、排程與工作 ownership → 完成配對及所有已啟用功能的 PG 讀寫 → 補遷各節點增量 → PG 模式完全不開啟業務 SQLite → 故障與跨節點驗收。

本文件是修正與交付指令。沿用專案既有權限：可完成開發、測試、分支及 PR；Production workflow 保持 manual-only。本輪「請 ChatGPT 幫忙審查」不新增 Production 部署、資料回填、切流、刪庫或關閉既有功能的批准。把這些正式變更先做成具體、可審查的一份執行包，依 Owner 已明確批准的範圍執行；沒有相應批准的部分，在準備完成後集中列出待執行項目。

不要覆蓋現有未 commit 的報告或其他工作。將原始報告與本文件一起納入交接 PR，保留報告原始觀測時間；後續更正另加註，不能把當時未知的事改寫成當時已確認。

## 1. 證據邊界與本次新增發現

ChatGPT 已讀取附件完整內容，並直接讀取上述 commit 的 GitHub 程式碼。以下分為「程式碼已確認」、「報告觀測」與「待正式機驗證」。ChatGPT 本輪沒有登入 NAS、操作正式資料庫、部署或執行完整 CI。

報告中的 93 秒 +13 筆、各資料庫筆數、WAL 時間及容器環境屬 DeepSeek 的觀測，尚未由 ChatGPT 重新測量。另因正式容器的 /app/src、/app/public 是 host bind mount，**image revision／digest 不能單獨證明執行中的程式等於 GitHub commit**；需補實際掛載來源、容器內關鍵檔案內容 hash 與候選版本的比對。

| 編號 | 已核對的程式碼 | 判斷與處理 |
|---|---|---|
| F1 | server.js 的 /api/public/listings 呼叫 listPublicListingsFast；db.js 的 fast／一般路徑均使用同步 SQLite handle | **訪客 API 在本 commit 並未接入 PG 搜尋。** 不只是假設 projection 少建。先修這個實際入口、快取及裝飾資料來源。[G1][G2] |
| F2 | listingSearchAsync.js：repository.searchPage 無法處理時直接回 searchListingsSqlite；發生例外也回 SQLite | PG 健康時也可能因篩選、排序而讀舊 SQLite。options.strict 只處理 catch，沒有阻止「查詢不支援」的回退。[G3] |
| F3 | listingSearchSql.js 的 SQL 範圍排除 kind／sources／q、部分 filter／sort／settings；查詢由 listing_search_projection 取 ID | 關掉錯誤 fallback 還不夠，必須補齊現有產品查詢能力；不能以刪除選項或回空集合交差。[G4] |
| F4 | listingGroups.js 的 recordMatchEvaluation 捕捉所有錯誤；註解稱供缺表的 isolated tests 使用 | 唯讀造成的寫入失敗也可能被吞掉。需移除正式路徑的全面吞錯，並驗證錯誤可追蹤。[G5] |
| F5 | db.js 在模組載入時建立 DatabaseSync、設 WAL、建表與啟動 projection 回填；ensureChangeLogStoreOnce 仍以 SQLite schema 建 PG schema | **啟動與 migration 也依賴 SQLite。** 只修改業務 INSERT，仍無法讓 PG 模式在沒有 v3.db 時運作。[G6] |
| F6 | watcher 呼叫同步 getSettings、coveringPlan、replaceCrawlCovers、listingCount 等；coveringPlan 本身還可能呼叫 armMemberExternalFetch 寫設定 | 呼叫名稱像讀取或計畫，不代表沒有副作用。需處理從排程入口到狀態提交的完整流程。[G7][G8] |
| F7 | persistListing 在 PG 分支連續執行 upsert、backfill、syncProjection，沒有包住整段的交易；projection 使用傳入 listing | 主列與投影可能部分成功；投影也可能沒反映 backfill 後實際列。需故障注入與欄位一致性測試，不能只看筆數。[G9] |
| F8 | withBudget 使用 Promise.race；tick gate 是程序內記憶體狀態 | 本輪對原始 helper 的獨立重現：timeout 已拋錯後，工作仍繼續執行。逾時不等於取消，需真正取消及防止舊工作提交。[G10] |
| F9 | rotateCoveringJobs 用 wall clock 時間窗口選取切片，沒有持久化完成游標 | 原始函式重現：同一 15 分鐘窗會取同一批；19 組條件、上限 6、每 30 分鐘啟動時，7–12 與 19 號組均未被選中。這是可重現情境，**不是聲稱正式機已發生同一漏抓**。[G11] |
| F10 | server 切片 plan.jobs 後，仍傳入整份 plan.includedUserIds；完成函式更新所有 crawl_covers 及傳入會員到期時間 | 存在把未涵蓋條件／會員當成已完成的風險。必須依本批真正成功項目提交完成狀態，驗證會員與 cover 的映射。[G7][G12] |

因此，不能接受「主資料已全部走 PG」這種沒有區分入口的結論。較準確的描述是：**部分房源入庫與部分會員讀寫已接 PG；訪客搜尋及若干會員、排程與背景流程仍有 SQLite 依賴。**

### 原報告需要更正的推論

1. db.prepare 次數包含 SELECT 等操作，不能稱為「150 處同步寫入」，也不是 150 個都需要移植。某些同步模組已有 Async wrapper；是否仍被正式入口呼叫才是重點。
2. 表筆數不變不代表無寫入：UPDATE、同量 DELETE＋INSERT、清空再重建都可能讓 COUNT 一樣。甚至前後內容相同，也不能排除中途曾寫入。
3. mtime 是輔助證據。WAL／checkpoint／SHM 行為不能單獨證明哪張表被哪個程序寫入；web-A 的單次 mtime 不能證明它在觀測窗持續進行業務寫入。需逐節點前後觀測與執行追蹤。
4. PG 32,198 與 SQLite 115,618 相差 83,420；86,564 是 PG listings 118,762 減 PG projection 32,198。兩種差距不可混用；兩者也都不等於「實際少顯示幾筆」。
5. PG 有某張表、或兩邊 row count 相等，不代表該功能讀寫完整，也不代表 standby 的複寫狀態已被驗證。
6. 把所有 islands 移植到 PG，**不會自動更新舊 SQLite**，因此無法恢復「切回 SQLite 不丟資料」的保證。
7. 目前評估資料主要是逐候選的紀錄。紀錄不一致尚不能單獨證明最後配對判斷已不同；必須追蹤 group、member、listing.match_*、人工裁決及通知綁定。

## 2. 對原報告八個裁決問題的正式答覆

| 問題 | 決定 | 執行要求 |
|---|---|---|
| 1. 評估表要 upsert 或只記變更？ | 採「目前有效狀態＋有意義的變更歷程」，但先保證完整搬遷；不要只以 post_id 去重 | 一個 incoming 可對多個 candidate 評估。使用有方向的 incoming／candidate、matcher version 及必要 scope 作業務鍵；是否能對稱化須由演算法證明。記錄輸入版本／hash、判斷內容與時間，保留人工稽核歷史。 |
| 2. 正式 PG 讀取也 fail-closed？ | **是，正式業務讀寫均禁止回退節點 SQLite** | PG 錯誤回明確暫時不可用，不能回空清單／預設設定／假成功。權限、身分、管理設定、會員資料不使用過期回退。公開快取若要降級，須是明確 TTL、來源 PG、可標記過期的獨立設計，預設不新開此例外。 |
| 3. rollback 只支援 PG 內回版？ | **是，以相容 PG schema 的應用版本回版** | 預先驗證指定 digest＋schema；不能任選歷史版本。資料復原另走 PG backup／PITR／經驗證的 standby 復原程序，列明 RPO／RTO。 |
| 4. crawl_covers 改純觀測？ | **目前不批准只憑時間戳把它降成純觀測** | 先盤點所有 consumer，區分計畫、run、job、完成紀錄。可以讓既有表成為讀取用投影，但排程必須有 PG 中可恢復的權威狀態。單一 settings 時間戳不足以表達各 cover 的成功與 ownership。 |
| 5. 加 SQLite 守門？ | **要，而且不能取代移植** | 測試／預備環境先嚴格阻擋；正式 PG 模式最終連業務 SQLite 都不開啟。防止新連線、exec、prepare、DDL、bootstrap 和吞錯繞過。正式設定不保留 PG_SQLITE_FALLBACK=open 的逃生門。 |
| 6. 唯讀整個 /data？ | **不要整個 /data 唯讀；優先讓 runtime 完全不掛載業務 SQLite** | 封存庫放獨立路徑，只有維運工具可讀。媒體與必要設定各自管理。不要以逐個綁定活躍 v3.db、-wal、-shm 的方式充當最終退場。 |
| 7. 如何窮舉遺漏？ | **呼叫路徑清單＋執行攔截＋沒有 SQLite 的整合測試＋業務閉環＋內容比對** | 含啟動、cron、worker、admin、CLI、失敗重試、罕見功能；COUNT／mtime 僅輔助。完整 coverage 及結構性禁止連線才是證據。 |
| 8. 15 個 domain 必須全搬？ | **所有仍啟用、會處理正式持久狀態的路徑都必須完成** | 包含會員刊登、許願房、媒體 metadata、回饋、通知、佇列、預算等。真正未啟用且所有入口／worker 都不可到達的 domain 可另列；不得自動關掉現有功能來湊完成率。不能用 sticky session 充當 HA 完成。 |

本機／測試繼續支援 DB_DRIVER=sqlite。正式部署規格則必須明確指定 postgres；缺少／拼錯 driver、錯誤環境、打開 SQLite fallback 應在啟動檢查被拒絕，不能悄悄採用開發預設值。

## 3. 實作與 PR 順序

各 PR 依依賴順序拆分，提供一個整合候選分支／版本做最終驗收。不要拆成互相不相容的獨立部署；不用每個 PR 做完都停下等 ChatGPT。中途只因實際阻塞而集中列出資訊缺口，其餘工作繼續。

### PR-A：存取清單、資料保存與可見的錯誤邊界

交付一張完整矩陣：

| entrypoint／使用情境 | 已啟用？ | facade／repository | 讀取來源 | 寫入來源 | 是否有 fallback／吞錯 | 交易與副作用 | 測試與遷移狀態 |
|---|---|---|---|---|---|---|---|
| 每一實際 route、scheduler、worker、啟動 migration、維運 CLI 各一列 | 含證據 | 追到真實連線 | PG／SQLite／快取 | 同左 | 列出觸發條件 | 包括通知與計費 | 不准只填「有 PG 表」 |

用 rg 先找 DatabaseSync、node:sqlite、better-sqlite3、sqlite3、sqliteHandle、prepare、exec、transaction、db.run、fallback、catch、初始化與動態 import，再追每個呼叫者。SQL 第一個字的 regex 無法可靠辨認 CTE 寫入、trigger、PRAGMA、ATTACH 或多語句，不可拿它當唯一阻擋器。

加入可辨識的資料來源違規錯誤碼，例如 SQLITE_ACCESS_FORBIDDEN_IN_PG。錯誤邊界必須先記錄已清理敏感值的 operation、table／domain、process role、node、stack fingerprint；不得记錄完整 SQL bind 值、連線密碼或會員內容。正式禁止違規被空 catch 吞掉。

先保存各節點 SQLite 一致性快照及 PG 備份資訊，再處理資料。可使用 SQLite Online Backup API／驅動正確 backup 方法；不可只 cp 正在運行的 v3.db，因未 checkpoint 的已提交資料可能仍在 WAL。備份先驗證能開啟及 integrity，再用副本分析。[S1][S2]

唯讀操作不代表零 side effect：開啟 WAL 資料庫可能涉及 SHM／檔案協調；報告應清楚區分「沒有業務 DML」與「作業系統檔案完全不變」。

### PR-B：訪客／會員搜尋完整改走 PG，修復 projection

1. /api/public/listings 建立並接入真正的 async driver-aware 入口。把設定、主列、個人／公共可見性、群組、媒體、裝飾、total 與分頁的資料來源全部一併追到底。
2. 修改 public cache 使其支援 async loader，錯誤不得快取成空結果。保留訪客與登入狀態隔離，cache key 必須涵蓋查詢語意及必要的資料／schema 版本，不能混入個人標記。
3. 會員搜尋移除「PG 查詢不支援就跑 SQLite」及例外回退。包含 kind、sources、文字、各種 filter、通勤、fit、更多條件、個人狀態與分頁。
4. 尚未 SQL 化的功能可先採「PG 供料＋既有純 Node 計算」。必須維持完整候選、正確排序、total、cursor／offset；不可先任意截斷前 N 筆再過濾，或在每次請求全量載入造成不可接受的延遲。用有界查詢／分批計算及量測決定實作；效能不符即繼續修正。
5. PG 暫時不可用：API 回 503 及穩定錯誤碼（不要把資料庫故障映射成一般 400）；前端保留篩選輸入、顯示可重試訊息，不能顯示「0 間房源」或重設會員設定。
6. 不以打開 PUBLIC_LISTINGS_SQL_FIRST=1 作為修復。既有 db.js 已註明公共 SQL 與 Node 可見性曾有差異；先補齊語意並測試。

#### Projection 查核與修復

在同一個 PG snapshot／同一 schema／primary 中，至少檢查下列集合；查詢只有 SELECT，請在短時間的 REPEATABLE READ READ ONLY transaction 中完成並立即結束，避免長時間持有 snapshot。具體 schema 用實查值，不要依賴錯誤 search_path。

    -- PG 主列缺 projection：非兩種 store 的總數相減
    SELECT COUNT(*) AS missing
    FROM listings l
    WHERE NOT EXISTS (
      SELECT 1 FROM listing_search_projection p WHERE p.post_id = l.post_id
    );

    -- 孤兒 projection：相同總筆數也可能有缺列＋孤兒互相抵銷
    SELECT COUNT(*) AS orphaned
    FROM listing_search_projection p
    WHERE NOT EXISTS (
      SELECT 1 FROM listings l WHERE l.post_id = p.post_id
    );

此外確認重複鍵、欄位正確性、NULL／數字／時間語意，以及缺失集合中哪些通過「實際公共／會員可見性」條件。同步列出少量可重現 ID、來源、被排除原因；不能把所有主列都當應公開。

目前 computeListingProjection 對傳入主列產生投影，查詢由投影選 ID；沒有看到這條路徑宣告 projection 只保留 32,198 筆可見子集。因此以「每筆有效 listings 都有對應投影」作本輪預期，若發現另有明確契約，須附 code 證據修正預期，不能為了讓數字通過而改規則。

先修新寫入，再做 PG 主資料驅動的回填：

- 同一 PG 交易內完成主列 upsert／backfill，讀取資料庫最終 canonical row，再計算與寫入 projection。中間失敗就回滾該業務單位，不能主列成功而搜尋永久缺席。
- 若採非同步投影，必須有同交易 durable outbox、可恢復消費及明確可接受的延遲；本輪優先採同交易，避免增加系統複雜度。
- 回填分批、可重跑、可恢復、有限速與進度，防止舊快照覆蓋新值：同批使用一致交易／列鎖，或有來源版本比較及第二輪追補。不從舊 SQLite 當最新真相回填 PG。
- 不對線上 projection 先 TRUNCATE／DELETE 再慢慢補。若用新表建置，須補齊期間增量、驗證後在受控窗口切換。
- data_revision 是否是同步／快取／outbox 的契約須追查；若下游依賴它，不能沿用「輔助紀錄，失敗可忽略」而破壞同步。若確屬診斷，明確記錄其可丟失性與告警，不與必需交易混淆。

驗收應走實際 HTTP API：在測試 PG 新增一筆舊 SQLite 不存在且可見的房源，匿名與會員均能查到；切換至各節點仍相同。對所有支援篩選與排序進行對照，證明沒有回 SQLite，並驗證權限及個人欄位沒有外洩。

### PR-C：抓取、排程、佇列與預算的完整 PG 流程

包括 getSettings／coveringPlan／baseline count、crawl_covers、樂屋游標、source-kit retry、全站抓取設定、site keys、會員 due、job queue、通知 snapshots、重試／補齊及會產生副作用的 helper。

**排程狀態要求：**

- PG 內持久保存計畫版本、stable cover key、run／job 狀態、游標、owner、lease／generation、重試及完成結果；可沿用既有 jobQueue schema，不要求無理由另造框架。
- 至少區分 started_at、heartbeat_at、last_attempt_at、last_success_at、next_due_at。更新 heartbeat 不能冒充成功，也不能把其他未抓條件的下次執行時間一起推遲。
- 條件輪替按「實際完成／可恢復進度」推進，具失敗重試與公平性；不能只由 wall clock modulo 推論已完成。保留每輪限額與來源節流，避免恢復成超量抓取。
- crawl_covers 可保留為計畫／觀測資料；不可把每批 6 組當全站完整計畫、整表 DELETE 後重建而遺失未執行項目。以 stable key 與 plan version scoped upsert 管理，僅在完整計畫已原子更新時處理不再使用的條件。
- 完成時只更新該 run 真正成功的 cover，以及其確實滿足抓取需求的會員；不能對整表 UPDATE last_run_at，也不能將被切掉的 includedUserIds 標成完成。

**多節點工作 ownership 與 timeout：**

- Web role 預設不附帶抓取排程；worker role 由受控部署設定啟動。若多 worker，使用 PG 原子 claim、唯一冪等鍵及 lease／fencing token。不得依靠每個 Node process 的 busy 旗標避免重複。
- 可採 FOR UPDATE SKIP LOCKED 的短交易 claim，再於交易外執行外部 I/O。不要在數分鐘爬取期間一直持有長交易／列鎖。[S4]
- lease 到期／ownership 變更後，舊 worker 對結果、游標及完成狀態的提交必須被拒絕。使用 PG 時間及帶 token 的條件更新；PG 失聯則停止取得新工作，不能假設仍持有租約。
- 若使用 advisory lock，明確固定 session connection、處理失聯、pool 歸還與釋放；不能以一般 pool.query 取得 session lock 後換 connection 繼續。
- withBudget 改為傳播 AbortSignal／取消狀態；每次外部請求、批次提交與下一階段前檢查。即使某個 I/O 不能即時取消，也必須透過有效 ownership 拒絕遲到提交。
- 保留總 timeout 與有限重試。不得靠放大 timeout 或吞錯來消除故障測試。
- 通知與付費 provider 涉及外部副作用：以 durable outbox／idempotency key／查詢既有結果處理不確定成功；沒有供應商冪等支援時，不能保證 exactly-once，也不能盲目重試。
- 已啟用的預算與用量檢查在本批一併完成：跨節點原子 reservation、記帳及釋放。只有確實未啟用的付費路徑才可列為啟用前 gate。

### PR-D：同屋源群組與評估移植

先畫清楚：候選讀取 → 評估 → listing.match_* 更新 → group／members → 人工確認／拆分 → user flags／events 綁定 → audit。全部使用同一權威來源；應同成敗的變更在同一 PG 交易中完成，並處理 concurrent merge／split／人工裁決。

recordMatchEvaluation 搬到 repository 並由 driver-aware facade 呼叫；單純把紀錄 INSERT 改到 PG，不代表上游候選已離開 SQLite。

**評估資料模型：**

- 選用「latest／current view ＋ change history」。實體名稱可沿用現有表，避免不必要改 API；既有查詢與管理稽核要有相容遷移。
- current key 包含 incoming_post_id、candidate_post_id、matcher_version 和必要 scope；先保持方向，不自動把 A→B 與 B→A 合併。
- 沒有 candidate 的紀錄需有明確的 no-candidate 類型／鍵；不能因 UNIQUE 對 NULL 的語意而持續累加，也不要以無效房源 ID 假裝 candidate。
- 比較的是穩定序列化後的決策內容、signals、veto、confidence、輸入 revision／hash、版本等，而不只 level。相同內容可更新 last_evaluated_at／計數，不反覆追加歷程；歷程需事件冪等鍵。
- 非同步較舊評估不得覆蓋較新輸入版本的結果；以資料版本或受控 monotonic revision 比較，不只相信不同主機的時間戳。
- 人工 group audit 與演算法 debug history 分開管理；不以節省空間理由刪除人工裁決紀錄。
- 如果證明評估 log 純診斷，可容許其 PG 寫入失敗不阻塞主要入庫，但必須有 dropped／failed 指標及告警；不能回寫 SQLite。權威 group／會員／通知變更失敗則回報失敗或持久化重試。
- 本任務先保存既有約 85 萬筆紀錄。可提出 raw diagnostics 的可配置保留期限與估算，不在這次遷移自行刪除歷史；改保存策略時列明哪些內容會被壓縮及如何查舊紀錄。

### PR-E：所有已啟用 domain、媒體與會員狀態閉環

以下為必查範圍，不表示每一個檔案都還沒移植。已有 PG Async 路徑時，重點是確認入口確實接上。

| 範圍 | 必須驗證的閉環 |
|---|---|
| demand／wishOffers | 建立、編輯、條件分類、有效期、配對與提供房源；A 寫 B 讀、狀態轉換與通知同源 |
| selfListings／listingTools | 自有刊登、草稿／發布／下架、編輯、房源查詢與媒體關係、授權 |
| memberMedia | metadata、owner、上傳狀態、配額、刪除與檔案位置；成功上傳後每個可接流量節點均能取到 |
| rentalNotify／comms／feedbackOutbox／jobQueue | enqueue、claim、重試、ack、去重、lease 過期恢復；實際對外通知保持既有開關並用測試 sink 驗證 |
| support／feedback／contentDocuments | 提交、附件、管理處理、發布可見性、歷史及權限 |
| crm | 已啟用的會員／流程／outbox 與退出／訂閱契約；不能因有 crmAsync 就假設全部入口已接通 |
| listingSimilarity／userSameHouse | 演算法設定、工作取得、候選／投票、人工確認及使用者範圍隔離 |
| auth／users／sessions／permissions／settings | 註冊、登入、驗證、登出／撤銷、密碼重設、管理權限及設定；跨節點一致 |
| budgetGuard／providers | 全站預算、用量、reservation、取消與不確定結果處理，防止 A、B 各放行一次 |

媒體的二進位檔案可用現有共享物件儲存或已驗證的共用方案；**只把 metadata 搬 PG 不會讓 /data/member-media、self-photos 自動跨節點可見**。優先延續既有基礎建設，不先採購新服務；沒有可用方案時完成介面與遷移設計並列為正式 HA blocker。成功上傳的 durability／跨節點可見性要有測試，不能每台各存一份卻回相同 URL。

auth.env、vapid.json、session／signing key 的一致性只比較指紋與配置來源，不輸出秘密。PG 業務資料移植與秘密管理分開處理；不把密碼硬塞進資料表來迴避部署配置。

未啟用 domain 要有全節點設定證據、路由不可用、worker 不排程、沒有其他已啟用功能依賴。若需關閉既有功能，只能提出有影響範圍及恢復方法的正式變更，不能執行代理自行決定。

### PR-F：拆除 PG 啟動依賴與正式 SQLite 開關

1. 分離 SQLite adapter／bootstrap 與純計算、schema 定義、業務 facade。PG 模式載入模組時不得 new DatabaseSync、exec SQLite DDL、建 v3.db 或啟動 SQLite 回填 timer。
2. PG migration 由版本化 schema／明確 migration 檔執行，不從線上 SQLite 推導。必要的一次性 schema 轉換工具只留在受控離線遷移工具中。
3. migration／identity sequence 校正由單一受控程序執行，使用遷移鎖、進度及 current sequence 檢查；禁止每個 web 節點啟動時依舊快照重設序號、向後調整或競爭修改。
4. 移除正式 PG 的 PG_SQLITE_FALLBACK=open、options.fallback=open、錯誤 driver 靜默預設及分散的 try/catch 回退。不能只改 sqliteFallback.js；全路徑守同一契約。
5. 本機／測試的 SQLite driver 保留且可獨立工作。PG 測試會在 SQLite 資料不存在、不可寫、以及放有刻意不同的 sentinel 資料三種環境運行，以抓漏讀／漏寫。
6. 正式 runtime 最終不掛載舊業務 DB。封存用目錄與媒體、auth 設定分離；若暫時必須讓維運工具讀唯讀 SQLite，必須使用已穩定的一致快照，禁止把仍變動的庫宣告 immutable。[S1]

## 4. 各節點舊資料的補遷與衝突處理

**不得修完程式後直接忽略兩台／三台 SQLite 中已發生的新資料。** 除了 crawler log，也要尋找會員刊登、回饋、許願、人工配對與設定修改等可能只存在單一節點的資料。

依序完成：

1. 識別每個來源節點、容器、DB 實際路徑及 snapshot checksum／觀測時間。把 primary／standby 及 web／worker role 分開記錄，不以名稱推斷角色。
2. 把每份 SQLite 一致快照載入 PG staging schema 或獨立離線資料集，保留 source_node、source_snapshot、original_table、original_pk、import_batch_id；同 PK 不同內容不可直接互蓋。
3. 已知 cutover 時間只作參考，不能只用 updated_at >= 該時間：部分表沒有可靠時間戳，需主鍵集合＋內容差異＋業務事件核對。
4. 房源主列以正式 PG 為基礎，不全量以 SQLite 覆蓋。派生 projection 可由 PG 重建；人工內容、刪除意圖、權限與工作狀態須個別處理。
5. 自動遞增 ID 的跨節點撞號用 mapping 表重編，連同 FK／關聯 ID 修復；listing post_id 若有來源命名空間與既有穩定 ID 規則，必須保持該契約，不任意重編。
6. 衝突分三類：相同內容可去重；可由已證明業務版本決定者按版本；無法自動判斷的人工／權限／刪除衝突放入待裁決清單，不默默 last-write-wins，也不復活已刪除資料。
7. 多來源對相同通知／工作可能已執行過，匯入時不得當成新工作重送；保留 completed／sent 事實，對不確定結果核對實際外部 id／冪等鍵。媒體依 checksum／object ID 核對，不只看檔名。
8. dry-run 輸出預計新增／相同／更新／衝突／跳過／失聯引用數與理由，覆核後在測試副本完整演練；具 checkpoint、可重跑、不重複及中止後續跑能力。
9. 最終 Production 補遷必須阻止舊 writer 再寫同一 domain，保存最後一致快照，再補 delta 並驗證。沒有 mutation journal 的 SQLite，不能假裝可僅靠日期抓到所有刪除；必要時在受控短暫寫入窗口做最後全量內容比對。
10. 這個窗口、功能影響、預估時間、停止條件與回復方式一起列在正式執行包；避免舊 app 與新 app 同時向不同 store 寫入。確認資料完整前保留封存副本，不刪除正式原檔或 WAL。

## 5. 驗收矩陣：取代原報告的五條標準

只有「同 payload、兩 driver 讀回相同」不足以驗證 PostgreSQL 的交易、競爭、網路故障、重試或入口接線。SQLite 若本身有已知 bug，也不應機械複製；parity 以核准業務契約為基準，對修正後的行為另寫明確斷言。

| Gate | 必須通過的證據 |
|---|---|
| GATE-1：版本與拓樸 | master／PR exact SHA、候選 image digest、runtime source hashes、各節點角色／DB_DRIVER／實際 PG DB與schema／source mounts；web-B 不可填推測 PASS |
| GATE-2：PG 無 SQLite 啟動 | PG 模式在沒有 v3.db 的環境成功啟動、migration 完成、核心功能運作；SQLite 檔不存在且沒有新建；禁止 constructor／open 的 spy 或等價執行攔截為 0 |
| GATE-3：禁止錯誤回退 | 模擬 PG 失聯、read-only primary、schema 缺失、連線中斷；回正確失敗且不回 SQLite／空結果／假成功。放入不同 SQLite sentinel，回應永遠不得出現 sentinel |
| GATE-4：搜尋與投影 | 公共與會員所有既有查詢能力使用 PG；missing／orphan／重複及欄位錯誤依契約歸零；完整 ID 集合、排序、total、下一頁一致；新寫入／下架／更新後符合可見性 |
| GATE-5：跨節點業務 | 在 A 建立、B 讀取、B 更新、A 讀回，涵蓋設定、刊登、許願、人工配對、回饋、附件與 auth；新增、修改、刪除及權限隔離均測 |
| GATE-6：交易與冪等 | 主列寫完前／後、projection、群組轉移、audit／outbox 中途失敗；相關狀態不半套。模擬 commit 已成功但 client timeout，重試不重複、不重送副作用 |
| GATE-7：抓取公平與取消 | 19+ 組條件、多輪、同窗重跑、跳窗、重啟、條件增刪、單組失敗、全批失敗；全部仍有機會完成。timeout 後舊 worker 不再提交；成功只記對應 covers／會員 |
| GATE-8：多 worker | A、B 同時 claim 同一工作只有一個有效 owner；lease 到期回收、舊 token 拒絕、PG failover 後重新取得 ownership；預算 reservation 不超扣或重複放行 |
| GATE-9：補遷 | 各節點資料皆入清單；dry-run／重跑／衝突及 FK mapping／刪除意圖／媒體核對有證據；未解衝突影響核心資料時不可宣告完成 |
| GATE-10：完整執行覆蓋 | startup、web、admin、所有啟用 worker、維運／清理工作都實際執行；至少兩次連續完整覆蓋週期及所有輪替分片，且觀測不少於 30 分鐘，兩者取較長 |
| GATE-11：HA 與回版 | 全節點使用同一權威來源；指定舊應用版本能讀目前 PG schema 及新寫資料；測試節點故障／PG promotion／重連；量測 RPO、RTO、replication lag 與已確認寫入結果 |
| GATE-12：CI 可信度 | 真實獨立測試 PG service／隔離資料庫的測試在 CI 實跑，不能因缺 PG_URL 被 skip 卻標綠；整合候選 exact SHA 的既有必要測試也全綠 |

「完整覆蓋週期」以所有目前生效的 cover／來源／租戶條件被處理為定義；不是一次最多 6 組的小批。若 19 組每次最多 6 組，至少需多個批次，失敗重試或計畫改版也要被計入。

測試環境可用受控 clock 加速定時觸發，但不得跳過功能；Production 真實觀測與故障／寫入演練依 Owner 批准執行。無法在本次執行的正式觀測項目列 NOT_RUN／BLOCKED，不能用測試環境結果取代。

COUNT、檔案 mtime、PRAGMA data_version／total_changes、PG 統計都是輔助訊號：有連線、取樣或 reset 限制，不能當成全球零寫入證明。可在一致副本上逐表用穩定主鍵、型別／NULL／JSON 正規化、完整欄位 hash 做 diff；資料為多重集合時須保留重複次數。前後 diff 仍可能漏掉中途變更，所以最終以「runtime 不持有／不開啟該 store」及完整業務測試作結構性保證。

健康檢查要區分 process 存活與資料服務就緒；只有能接到正確 primary／所需 schema 且無禁止存取錯誤的 web instance 才進接流量池。避免 PG 全故障時靠不斷重啟程序假裝恢復；保留清楚的暫時不可用回應。

## 6. HA 邊界、備份與回版規則

**公開站讀寫同源、Web 可切換、PG 可復原是不同驗收項目；不能因有兩條 tunnel＋兩台 HAProxy 就宣告全部完成。**

- 一致性敏感的設定、權限、會員寫後讀、任務 claim 與預算操作先全部走 current primary（pg-rw）。pg-ro 只給已明確容忍延遲的查詢；不能把 standby 延遲誤診成 SQLite 問題。
- 實查 PG major version、synchronous_commit、synchronous_standby_names、replication state、LSN 與 lag。PG streaming replication 預設為非同步，不能僅以「有 standby」承諾已回覆成功的資料一筆不丟；同步配置也需要選定正確 standby 與失效處理，會影響可用性。[S3]
- 若目前沒有可靠自動選主與舊 primary 隔離機制，保留人工受控 promotion；先隔離舊 primary，再確認可接受的資料點與提升 standby。**HAProxy 的路由與健康檢查本身不能解決 split-brain。** Witness 可後補，但在沒有等價安全機制前，不宣告任意網路分割下可安全自動切換。[S5]
- PG 備份／WAL archive／PITR 與還原演練單獨驗證；standby 不是歷史備份，誤刪也可能被複寫。舊 SQLite 只是封存／對帳來源，不是持續同步的災難復原庫。
- 應用回版使用已測試、支援目前 PG schema 的候選 digest，schema migration 採先擴充後收斂；在回版窗口內保留相容欄位。若實際程式由 host bind mount 提供，回版還必須還原對應 source，不能只換 image tag。
- 沒有合格的舊 PG 版本時，明示目前需 roll-forward，先準備修正版；不能把未測試歷史版本稱為 fallback。
- 若未來確實需要回到 SQLite，另立「停寫／一致匯出／轉換／核對／單一 writer 切換」遷移任務。這不是這次 rollback 開關。

不要為了這次修正重做全部 HA 基礎設施；沿用既有可證明的機制，將缺少的 fencing、備份或資料共享證據補齊即可。

## 7. web-B 存取受阻時的處理

先使用既有授權的維運帳號、deploy key、管理通道或可見的部署證據。不要因 root 要密碼就判定全節點檢查無法做，也不要擅改 SSH 設定、停用 host key 驗證或索取密碼貼進對話。

產出一個可交由既有管理者執行的唯讀採證腳本，只輸出白名單欄位：容器角色／digest／重啟時間、DB_DRIVER、遮密 PG host／port／database／schema、runtime file hash、SQLite 路徑／size／mtime、worker 是否啟用，以及已清理的 PG 健康／複寫資訊。不要輸出完整 docker inspect、完整 env、auth.env、VAPID 或連線字串。

存取尚未恢復時，繼續完成程式、測試、遷移演練與其他節點採證，最後只把 web-B 的具體未驗項列為 blocker。不能把 web-B 填 PASS，也不能因它阻塞而停止所有可完成工作。

## 8. 最終回報格式與可交付成果

請一次交付以下內容，讓 ChatGPT 能獨立複驗，不只閱讀「全部完成」敘述：

1. 各 PR URL、exact HEAD、base SHA、整合候選 SHA、候選 image digest；分清「已寫 code／已測試／已合併／已部署／尚待批准」。
2. entrypoint／domain 遷移矩陣、每個殘留 SQLite 的用途及不可到達證據；有任何已啟用正式路徑仍依賴它即 FAIL。
3. 新增修正清單對應 F1–F10 與八個裁決，附檔案及行號；保留已修復項目的真實語意，沒有靜默移除既有功能。
4. 真實 PG 與 SQLite parity、交易／競爭／故障測試、實際 API 跨節點 UAT 的命令、結果與 exact SHA CI URLs；清楚列出 skipped／not run。
5. 各節點 snapshot manifest、PG 備份及還原演練、補遷 dry-run／衝突 mapping／run checkpoint；敏感原始資料另行受控保存，不 commit 到 repo。
6. projection 的 missing／orphan／可見集合／欄位差異及修正前後證據；切片輪替、timeout 取消及完成 cover／會員核對結果。
7. 正式執行 runbook：前置檢查、備份、停止舊 writer、最後 delta、schema／app rollout、跨節點驗證、觀測時間、停止條件、已驗證回版命令。正式操作集中成一次審批包，不把未測腳本直接當核准請求。
8. 簡明狀態表：GATE-1 至 GATE-12 各列 PASS／FAIL／NOT_RUN／BLOCKED 與證據位置。

最終狀態使用：

- IMPLEMENTATION_READY_FOR_REVIEW：程式與必要測試完成，正式部署／補遷／驗收可能仍待執行。
- PRODUCTION_SQLITE_EXIT_VERIFIED：正式全部啟用路徑不讀寫業務 SQLite、資料補遷驗證完成且正式觀測通過，才可使用。
- HA_ACCEPTANCE_PASS：另須跨節點狀態、媒體、worker ownership、PG 故障／回版與復原要求通過。

有未解的資料衝突、web-B 未驗、SQLite 回退、PG 測試被跳過或錯誤被吞掉時，不得使用後兩個完成狀態。完成所有已授權且能做的工作後，將剩餘實際阻塞一次彙整，交 ChatGPT 做最終審查。

## 9. 參考證據

所有 GitHub 連結固定在審查 commit；程式碼位置只代表該版本。官方文件用於核對資料庫行為；實作時以實際 runtime 版本再確認支援能力。

- 原始輸入：20260924-sqlite-production-status-report.md，DeepSeek／Cline，2026-09-24；正式機數值屬該報告觀測。
- [G1：訪客 HTTP 路由](https://github.com/Fyun48/5151/blob/9c6b7b04f9801717cb6696e8e095fde4c309473f/v3/src/server.js#L543)
- [G2：訪客 fast／Node SQLite 路徑](https://github.com/Fyun48/5151/blob/9c6b7b04f9801717cb6696e8e095fde4c309473f/v3/src/db.js#L7100)
- [G3：會員搜尋回退](https://github.com/Fyun48/5151/blob/9c6b7b04f9801717cb6696e8e095fde4c309473f/v3/src/listingSearchAsync.js#L65)
- [G4：搜尋條件範圍與 projection SQL](https://github.com/Fyun48/5151/blob/9c6b7b04f9801717cb6696e8e095fde4c309473f/v3/src/listingSearchSql.js)
- [G5：群組／配對評估 INSERT 與 catch](https://github.com/Fyun48/5151/blob/9c6b7b04f9801717cb6696e8e095fde4c309473f/v3/src/listingGroups.js#L162)
- [G6：SQLite 啟動與 schema 依賴](https://github.com/Fyun48/5151/blob/9c6b7b04f9801717cb6696e8e095fde4c309473f/v3/src/db.js#L493)
- [G7：watcher 的抓取計畫與本機狀態](https://github.com/Fyun48/5151/blob/9c6b7b04f9801717cb6696e8e095fde4c309473f/v3/src/watcher.js#L648)
- [G8：coveringPlan 的設定讀寫](https://github.com/Fyun48/5151/blob/9c6b7b04f9801717cb6696e8e095fde4c309473f/v3/src/db.js#L3939)
- [G9：PG 主列與 projection 寫入序列](https://github.com/Fyun48/5151/blob/9c6b7b04f9801717cb6696e8e095fde4c309473f/v3/src/db.js#L4319)
- [G10：timeout 與 process-local tick gate](https://github.com/Fyun48/5151/blob/9c6b7b04f9801717cb6696e8e095fde4c309473f/v3/src/crawlWatchdog.js)
- [G11：時間窗口輪替](https://github.com/Fyun48/5151/blob/9c6b7b04f9801717cb6696e8e095fde4c309473f/v3/src/crawlPolicy.js#L15)
- [G12：cover 完成與會員到期更新](https://github.com/Fyun48/5151/blob/9c6b7b04f9801717cb6696e8e095fde4c309473f/v3/src/coveringBookkeepingAsync.js)
- [G13：SQLite fallback 政策](https://github.com/Fyun48/5151/blob/9c6b7b04f9801717cb6696e8e095fde4c309473f/v3/src/sqliteFallback.js)
- [G14：逐候選評估](https://github.com/Fyun48/5151/blob/9c6b7b04f9801717cb6696e8e095fde4c309473f/v3/src/sameHouseReconcile.js#L163)
- [G15：projection 建立與回填](https://github.com/Fyun48/5151/blob/9c6b7b04f9801717cb6696e8e095fde4c309473f/v3/src/listingSearchProjection.js)
- [G16：原 PG 切換計畫](https://github.com/Fyun48/5151/blob/9c6b7b04f9801717cb6696e8e095fde4c309473f/v3/POSTGRES_SWITCH_PLAN.md)
- [S1：SQLite WAL、唯讀與 sidecar 行為](https://www.sqlite.org/wal.html)
- [S2：SQLite Online Backup API](https://www.sqlite.org/backup.html)
- [S3：PostgreSQL standby 與同步／非同步複寫](https://www.postgresql.org/docs/current/warm-standby.html)
- [S4：PostgreSQL SELECT／SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html)
- [S5：PostgreSQL failover、舊 primary 隔離與 witness](https://www.postgresql.org/docs/current/warm-standby-failover.html)

附：本輪只對 crawlPolicy／crawlWatchdog 的原始獨立函式做最小重現，結果為同窗重複批次、特定間隔漏組、timeout 後 work 仍繼續。此結果沒有替代上述完整 CI、正式機 UAT 或跨節點演練。

### 舊版本問題的最小複驗

在上述 commit 的 repository 根目錄執行；只測純函式／timer，不接資料庫或外部網站。這是展示舊缺陷的腳本；修正後應把結果改成正確的回歸斷言，不要把「缺陷還在」寫成 CI 通過條件。

    node --input-type=module <<'JS'
    import { rotateCoveringJobs } from './v3/src/crawlPolicy.js';
    import { withBudget } from './v3/src/crawlWatchdog.js';
    const jobs = Array.from({ length: 19 }, (_, i) => i + 1);
    const minute = 60_000;
    const pick = m => rotateCoveringJobs(jobs, {
      now: m * minute, intervalMs: 15 * minute,
    });
    const selected = new Set([0, 30, 60, 90].flatMap(pick));
    console.log('同一窗口的兩次選取', pick(1), pick(2));
    console.log('此排程未選到', jobs.filter(id => !selected.has(id)));
    let continued = false;
    try {
      await withBudget(async () => {
        await new Promise(resolve => setTimeout(resolve, 60));
        continued = true;
      }, 5);
    } catch (error) {
      console.log('預算錯誤', error.code);
    }
    await new Promise(resolve => setTimeout(resolve, 90));
    console.log('逾時後工作仍繼續', continued);
    JS

本輪結果：兩次都是 [1,2,3,4,5,6]；未選到 [7,8,9,10,11,12,19]；預算錯誤 TIMEOUT；逾時後 continued=true。真正的修復測試還要證明 DB 與外部副作用不會由失去 ownership 的舊工作繼續提交。
