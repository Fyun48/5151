// 變異測試工具（2026-09-27）。
//
// 用途：把「修正」逐條拿掉，確認**對應那一項測試會失敗**。沒有這一步的綠燈不能信任——
// 本系列先前已抓到多次「測試是空的、拿掉修正照樣過」。
//
// 用法：node v3/scripts/mutation-check.mjs <測試檔> [--json]
//   mutation 清單寫在 MUTATIONS，每條都要指名「預期被殺掉的測試」。
//   `from` 必須在檔案中**恰好出現一次**（避免改錯地方，見 AGENT-RULES §七.2）。
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SRC = "v3/src/sameHouseAsync.js";
const USER_SRC = "v3/src/userSameHouseAsync.js";
const AUDIT_SRC = "v3/src/adminAuditAsync.js";

// 稽核失敗可視性的變異集（v3/test/admin-audit-visibility.test.js）。
// 這一組要證明的是「痕跡真的會留下」——因為「沒有痕跡」正是原本壞掉的東西。
const AUDIT_MUTATIONS = [
  {
    name: "拿掉記數與寫 log（回到完全隱形的 catch）",
    file: AUDIT_SRC,
    from: "    noteAuditFailure(error);\n    throw error;",
    to: "    throw error;",
    expect: "必須記數",
  },
  {
    name: "失敗改成靜默回傳（不再往外丟，契約被改掉）",
    file: AUDIT_SRC,
    from: "    noteAuditFailure(error);\n    throw error;",
    to: "    noteAuditFailure(error);\n    return null;",
    expect: "仍然往外丟",
  },
  {
    name: "計數器不遞增（有 log 但數字永遠 0）",
    file: AUDIT_SRC,
    from: "  auditFailures += 1;",
    to: "  auditFailures += 0;",
    expect: "必須記數",
  },
  {
    name: "每次都印 log（洗版）",
    file: AUDIT_SRC,
    from: "  if (auditFailureLogs === 1 || auditFailureLogs % AUDIT_FAILURE_LOG_EVERY === 0) {",
    to: "  if (true) {",
    expect: "不得洗版",
  },
  {
    // 複合變異：單獨把條件改回耦合版是「等價變異」（計數器正常時行為相同），殺不掉。
    // 必須與「計數器壞掉」同時發生，才顯現出耦合的代價——那正是解耦要防的情況。
    name: "（複合）計數器壞掉＋日誌節奏耦合失敗計數 → 會洗版",
    file: AUDIT_SRC,
    from: "  if (auditFailureLogs === 1 || auditFailureLogs % AUDIT_FAILURE_LOG_EVERY === 0) {",
    to: "  if (auditFailures === 1 || auditFailures % AUDIT_FAILURE_LOG_EVERY === 0) {",
    also: [{ from: "  auditFailures += 1;", to: "  auditFailures += 0;" }],
    expect: "洗版",
  },
  {
    name: "成功路徑也記成失敗（把正常當故障）",
    file: AUDIT_SRC,
    from: "    return await writeAdminAuditPg(params, options);\n  } catch (error) {",
    to: "    const r = await writeAdminAuditPg(params, options);\n    noteAuditFailure(new Error(\"forced\"));\n    return r;\n  } catch (error) {",
    expect: "成功時不得計數",
  },
];

const REJECT_MUTATIONS = [
  {
    name: "拿掉 user_match_votes 的 upsert（票不會落地）",
    file: SRC,
    from: "    await exec(UPSERT_VOTE_SQL, [uid, lo, hi, pairConfidence(listing, peer), now, now]);\n",
    to: "",
    expect: "首次拆開",
  },
  {
    name: "拿掉 user_match_signals 的 insert（訊號不會落地）",
    file: SRC,
    from: "    await exec(INSERT_SIGNAL_SQL, [uid, lo, hi, now]);\n",
    to: "",
    expect: "首次拆開",
  },
  {
    name: "拿掉 user_events 的寫入（拆開事件不會落地）",
    file: SRC,
    from: "    await addUserEventAsync(exec, {",
    to: "    void (({ user_id: 0 })); await (async () => ({}))({",
    expect: "首次拆開",
  },
  {
    name: "拿掉全站升級的 UPDATE（verdict 永遠不會變 no）",
    file: SRC,
    from: "    await exec(PROMOTE_SPLIT_SQL, [lo, hi]);\n",
    to: "",
    expect: "升級全站拆開",
  },
  {
    name: "把 promote 的 hidden=0 拿掉（拆開後物件仍隱藏）",
    file: SRC,
    from: "   SET match_verdict = 'no', match_rejected = 1, hidden = 0",
    to: "   SET match_verdict = 'no', match_rejected = 1, hidden = hidden",
    expect: "升級全站拆開",
  },
  {
    name: "管理員拆開誤加 hidden=0（覆蓋掉不該動的欄位）",
    file: SRC,
    from: "const ADMIN_SPLIT_SQL = `UPDATE listings\n   SET match_verdict = 'no', match_rejected = 1\n   WHERE post_id IN (?, ?)`;",
    to: "const ADMIN_SPLIT_SQL = `UPDATE listings\n   SET match_verdict = 'no', match_rejected = 1, hidden = 0\n   WHERE post_id IN (?, ?)`;",
    expect: "管理員拆開",
  },
  {
    name: "拿掉『已經投過 split 就不重複寫』的守衛",
    file: SRC,
    from: '  if (existing?.vote !== "split") {\n    const peer = (await exec(PEER_LEVEL_SQL, [otherId]))[0];',
    to: "  if (true) {\n    const peer = (await exec(PEER_LEVEL_SQL, [otherId]))[0];",
    expect: "重複拆開",
  },
  {
    name: "拿掉每日上限的判斷（rate_limit 永遠不觸發）",
    file: SRC,
    from: "  if (existing?.vote !== \"split\" && used >= MATCH_SPLIT_DAILY_LIMIT) {",
    to: "  if (false) {",
    expect: "每日上限",
  },
  {
    name: "每日計數忽略日期條件（昨天的票也算今天）",
    file: SRC,
    from: "   WHERE user_id = ? AND vote = 'split' AND created_at >= ?`;",
    to: "   WHERE user_id = ? AND vote = 'split' AND created_at >= '0000'`;",
    expect: "跨日不計入",
  },
  {
    name: "countPairVotes 不計票（永遠 0 票，不可能升級）",
    file: SRC,
    from: '    if (row.vote === "split") out.split = Number(row.n) || 0;',
    to: '    if (row.vote === "split") out.split = 0;',
    expect: "升級全站拆開",
  },
  {
    name: "管理員拆開不解除群組綁定",
    file: SRC,
    from: "  await unbindListingFromGroup(exec, a, { now });\n  await unbindListingFromGroup(exec, b, { now });\n",
    to: "",
    expect: "管理員拆開",
  },
  {
    name: "管理員拆開不寫 listings 的 verdict",
    file: SRC,
    from: "  await exec(ADMIN_SPLIT_SQL, [a, b]);\n",
    to: "",
    expect: "管理員拆開",
  },
  {
    name: "把 COALESCE 改回 SQLite 的 IFNULL（正式站會拋錯）",
    file: SRC,
    from: "   WHERE match_post_id = ? AND COALESCE(match_verdict, '') != 'no'",
    to: "   WHERE match_post_id = ? AND IFNULL(match_verdict, '') != 'no'",
    expect: "找不到 peer",
  },
  {
    name: "個人拆開：剩 1 人時不刪除（留下孤兒成員）",
    file: USER_SRC,
    from: "  if (remain.length === 1) {\n    await exec(DELETE_ONE_SQL, [uid, remain[0]]);",
    to: "  if (false) {\n    await exec(DELETE_ONE_SQL, [uid, remain[0]]);",
    expect: "剩 1 人時整組刪除",
  },
  {
    name: "個人拆開：剩 2 人以上不重新分組（沿用舊 group_key）",
    file: USER_SRC,
    from: "    const next = newGroupKey();",
    to: "    const next = keyA;",
    expect: "剩 2 人以上",
  },
  {
    name: "非 postgres 不回退、直接走 PG 分支（SQLite 站會壞）",
    file: SRC,
    from: '  if ((options.driver || resolveDbDriver()) !== "postgres") {\n    const { rejectSuspectedMatch } = await import("./db.js");\n    return rejectSuspectedMatch(postId, userId, { peerId, admin });\n  }',
    to: "  if (false) {\n    const { rejectSuspectedMatch } = await import(\"./db.js\");\n    return rejectSuspectedMatch(postId, userId, { peerId, admin });\n  }",
    expect: "非 postgres",
  },
];

const testFile = process.argv[2] || "v3/test/reject-match-async.test.js";
const asJson = process.argv.includes("--json");
// --only=<子字串>：只跑名稱含該子字串的變異（除錯用）。
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? onlyArg.slice("--only=".length) : "";

// 被中斷時一定要把原始碼還原——第一版沒有這段，SIGTERM 之後原始碼停在「已變異」的狀態，
// 依測試檔挑變異集。預設是 reject-match；稽核可視性用另一組。
const MUTATIONS = /admin-audit-visibility/.test(testFile) ? AUDIT_MUTATIONS : REJECT_MUTATIONS;

// 差點把一個壞掉的修正當成完成品。任何中斷路徑都要走 restoreAll()。
const PRISTINE = new Map();
function restoreAll() {
  for (const [file, text] of PRISTINE) {
    try { writeFileSync(file, text); } catch { /* 盡力而為 */ }
  }
}
for (const file of new Set(MUTATIONS.map((m) => m.file))) PRISTINE.set(file, readFileSync(file, "utf8"));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { restoreAll(); process.exit(130); });
}
process.on("uncaughtException", (error) => { restoreAll(); console.error(error); process.exit(1); });
process.on("exit", restoreAll);

function runTests() {
  try {
    const out = execFileSync(process.execPath, ["--test", testFile], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { out, failed: false };
  } catch (error) {
    return { out: `${error.stdout || ""}${error.stderr || ""}`, failed: true };
  }
}

function failingNames(out) {
  return out.split("\n").filter((l) => l.startsWith("not ok ")).map((l) => l.replace(/^not ok \d+ - /, "").trim());
}

const results = [];
for (const m of MUTATIONS) {
  if (ONLY && !m.name.includes(ONLY)) continue;
  const original = readFileSync(m.file, "utf8");
  // `also` 支援「複合變異」：有些修正只有在**兩個地方同時改壞**時才看得出價值
  // （例：日誌節奏若與失敗計數耦合，只有計數器也壞掉時才會洗版）。
  // 單獨改一處是「等價變異」，殺不掉也不該假裝殺得掉——複合起來才測得到。
  const steps = [{ from: m.from, to: m.to }, ...(m.also || [])];
  let mutated = original;
  let skip = "";
  for (const step of steps) {
    const hits = mutated.split(step.from).length - 1;
    if (hits !== 1) { skip = `"${step.from.slice(0, 48)}…" 在 ${m.file} 出現 ${hits} 次（必須恰好 1 次）`; break; }
    mutated = mutated.replace(step.from, step.to);
  }
  if (skip) {
    results.push({ ...m, status: "SKIP", detail: skip });
    continue;
  }
  writeFileSync(m.file, mutated);
  let r;
  try {
    r = runTests();
  } finally {
    writeFileSync(m.file, original);
  }
  const killers = failingNames(r.out);
  const killed = killers.some((n) => n.includes(m.expect));
  results.push({
    ...m,
    status: killed ? "KILLED" : "SURVIVED",
    detail: killed ? killers.filter((n) => n.includes(m.expect)).join(" / ") : `沒有任何測試失敗${r.failed ? "" : "（整輪竟然全綠）"}`,
    allFailures: killers,
  });
  if (!asJson) {
    const bad = killed ? "OK  " : "BUG ";
    console.log(`[${bad}] ${m.name}\n       預期殺手「${m.expect}」→ ${killed ? "已失敗 ✓" : "**沒有失敗** ✗"}`);
    if (!killed) console.log(`       實際失敗項：${killers.length ? killers.join(" / ") : "（無）"}`);
  }
}

const survived = results.filter((r) => r.status === "SURVIVED");
const skipped = results.filter((r) => r.status === "SKIP");
if (asJson) console.log(JSON.stringify(results, null, 2));
else {
  console.log(`\n共 ${results.length} 條變異：KILLED ${results.length - survived.length - skipped.length}、SURVIVED ${survived.length}、SKIP ${skipped.length}`);
  for (const s of skipped) console.log(`  SKIP ${s.name} :: ${s.detail}`);
  for (const s of survived) console.log(`  SURVIVED ${s.name}`);
}
process.exit(survived.length ? 1 : 0);
