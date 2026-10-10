#!/usr/bin/env bash
# PG 整合測試入口（astra 2026-09-25 §3）。
#
# 為什麼要獨立入口：
#   • 一般測試 job 必須**保持 driver 隔離**（不要用全域 DB_DRIVER=postgres 把所有 SQLite／預設
#     driver 測試都改成走 PG）。
#   • 但 PG 專屬的回歸（provider 護欄、單一快照、PG context、live PG parity）必須在**真 PG**上跑，
#     而且不能靠 skip 掩蓋問題。
#   ⇒ 這裡自動收斂「canary ＋ 所有以 PG_TEST_URL 為 gate 的整合測試」，新增檔案不會被漏掉。
#
# 需要先套 schema：`node v3/scripts/pg-integration-setup.mjs`（由 npm run test:pg 串好）。
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

# 收檔自我檢查（**離線**、不需要 PG，所以放在「有沒有 PG」之前，兩種情境都會跑到）。
#
# 為什麼一定要有：下面的收檔方式是 `grep -rl PG_TEST_URL v3/test/*.test.js`——一支測試要不要被
# 執行，取決於**檔內有沒有那個字串**。某支測試的檔頭一旦被清掉（或字串被改寫），那一支就
# **永遠不再執行、而且 CI 全綠**（沒有紅燈、沒有 skip 訊息）。2026-10-10 的
# `write-path-http-live-pg.test.js` 就是這種形狀（它的收檔依據只是檔頭一句話）。
# `check-pg-collection.mjs` 會斷言：目標檔在清單內、KEEP 標記逐字還在、且以 master 的 69 支
# 為基準沒有任何一支消失（多出來的只警告）。
#
# ⚠️ 這裡**刻意把它的 stdout 導到 stderr**：這支腳本「沒有 PG 時 stdout 必須是空的」是既有契約，
#    `v3/test/domain-tool-guards.test.js`（「沒有 PG 要大聲 SKIP」那條）逐字在斷言它
#    ⇒ 檢查報告走 stderr，stdout 只留給真正跑測試的那條路徑。
if ! node v3/scripts/check-pg-collection.mjs >&2; then
  echo "[pg] 收檔自我檢查失敗 ⇒ 不執行任何 PG 整合測試（原因見上方 [pg-collect] 訊息）" >&2
  exit 1
fi

if [ -z "${PG_URL:-}${PG_TEST_URL:-}${PGHOST:-}" ] && [ "${DB_DRIVER:-}" != "postgres" ]; then
  # 第八十八批：原本這裡靜默 exit 0，於是「PG 整合測試通過」可能只是「根本沒跑」。
  # 現在明講 SKIP；需要「沒 PG 就失敗」的場合設 REQUIRE_PG=1（CI 的 PG job 就是這種）。
  echo "[pg] SKIP：沒有設定 PG（PG_URL／PG_TEST_URL／PGHOST／DB_DRIVER=postgres）⇒ 沒有執行任何整合測試" >&2
  if [ "${REQUIRE_PG:-}" = "1" ]; then
    echo "[pg] REQUIRE_PG=1 ⇒ 視為失敗" >&2
    exit 1
  fi
  exit 0
fi

files=(v3/test/pg-provider-canaries.test.js)
while IFS= read -r f; do
  [ -n "$f" ] && files+=("$f")
done < <(grep -rl PG_TEST_URL v3/test/*.test.js | sort)

echo "[pg] 執行 ${#files[@]} 個整合測試檔"
# 序列執行（astra 2026-09-25 裁決 §3「檢查並行」）：
#   CI 的 PG 測試**共用同一個拋棄式 PG 實例** ⇒ 多檔並行時，別的檔會在同一張表上操作
#   （實例：`job-queue-parity` 的 claim 被其他檔搶走剛排進去的那筆 ⇒ 偶發紅 ✗，
#     根因分析見 docs/handoffs/PRB_EXECUTION_STATE.md §3e ✓）。
#   序列化是最小且對症的做法 ✓ —— 不以「重跑後綠」結案 ✗。
exec node --test --test-concurrency=1 "${files[@]}"
