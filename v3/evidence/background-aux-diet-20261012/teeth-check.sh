#!/usr/bin/env bash
# 逐條「把改動反向」看測試會不會紅（有牙齒驗證）。每個變異跑完一定還原。
set -u
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
T=v3/test/background-aux-diet.test.js
run() { # run <名稱> <預期: fail|pass> <測試名稱片段>
  local name="$1" want="$2" needle="$3"
  local out
  out=$(timeout 300 node --test "$T" 2>&1)
  local ok fail
  ok=$(printf '%s' "$out" | grep -c "^ok ")
  fail=$(printf '%s' "$out" | grep -c "^not ok ")
  printf '%-42s pass=%s fail=%s (期望 %s)\n' "$name" "$ok" "$fail" "$want"
  if [ "$want" = "fail" ] && [ "$fail" -eq 0 ]; then echo "  ✗ 沒紅！變異沒被抓到"; return 1; fi
  if [ "$want" = "pass" ] && [ "$fail" -ne 0 ]; then echo "  ✗ 不該紅卻紅了"; printf '%s\n' "$out" | grep -A5 "^not ok" | head -20; return 1; fi
  printf '%s\n' "$out" | grep "^not ok" | sed 's/^/  -> /'
  return 0
}

echo "== 基準（未變異）=="
run "baseline" pass "" || exit 1

cp v3/src/listingEnrichQueueAsync.js /tmp/bgaux/m1.bak
python3 - <<'PY'
p="v3/src/listingEnrichQueueAsync.js"
s=open(p).read()
s=s.replace("existing: existingByPostId.get(postId) || null,","existing: undefined,")
open(p,"w").write(s)
PY
echo "== 變異 1：seed 改回逐列讀取 =="
run "seed 逐列版" fail ""; M1=$?
cp /tmp/bgaux/m1.bak v3/src/listingEnrichQueueAsync.js

cp v3/src/repository/notifyEnqueue.js /tmp/bgaux/m2.bak
python3 - <<'PY'
p="v3/src/repository/notifyEnqueue.js"
s=open(p).read()
old="""  const lastRows = await run(queries.lastEventDetailsBatch(userIds, payload.post_id, payload.type));
  for (const row of lastRows || []) {
    const userId = Number(row.user_id) || 0;
    // ORDER BY user_id, id DESC ⇒ 每個 user 的第一列就是逐筆版會拿到的那一列。
    if (!lastDetail.has(userId)) lastDetail.set(userId, row.detail);
  }"""
new="""  for (const userId of userIds) {
    const rows = await run(queries.lastEventDetail(userId, payload.post_id, payload.type));
    if (rows.length) lastDetail.set(userId, rows[0].detail);
  }"""
assert old in s
s=s.replace(old,new)
open(p,"w").write(s)
PY
echo "== 變異 2：通知去重改回逐會員版 =="
run "notify 逐會員去重" fail ""; M2=$?
cp /tmp/bgaux/m2.bak v3/src/repository/notifyEnqueue.js

cp v3/src/watcher.js /tmp/bgaux/m3.bak
python3 - <<'PY'
p="v3/src/watcher.js"
s=open(p).read()
old="""  const roundOptions = roundRows
    ? { ...options, globalRows: roundRows, requestContext: decorationRequestContextFromRows(roundRows) }
    : options;"""
new="""  const roundOptions = options;"""
assert old in s
s=s.replace(old,new)
open(p,"w").write(s)
PY
echo "== 變異 3：flush 不再把當輪 settings 往下傳 =="
run "flush 逐事件讀 settings" fail ""; M3=$?
cp /tmp/bgaux/m3.bak v3/src/watcher.js

cp v3/src/repository/notifyEnqueue.js /tmp/bgaux/m4.bak
python3 - <<'PY'
p="v3/src/repository/notifyEnqueue.js"
s=open(p).read()
s=s.replace("      requestContext,\n","")
open(p,"w").write(s)
PY
echo "== 變異 4：通知入列的裝飾不再共用當輪 settings =="
run "notify 裝飾重讀 settings" fail ""; M4=$?
cp /tmp/bgaux/m4.bak v3/src/repository/notifyEnqueue.js

echo "== 還原後再跑一次 =="
run "restored" pass "" || exit 1
echo "M1=$M1 M2=$M2 M3=$M3 M4=$M4（0 = 該紅有紅）"
