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

if [ -z "${PG_URL:-}${PG_TEST_URL:-}${PGHOST:-}" ] && [ "${DB_DRIVER:-}" != "postgres" ]; then
  echo "[pg] 沒有設定 PG（PG_URL／PG_TEST_URL／PGHOST／DB_DRIVER=postgres）⇒ 不執行整合測試" >&2
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
