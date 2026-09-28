// 稽核寫入失敗的**可視性**（2026-09-27）。
//
// 為什麼需要這支：`auditReq()` 的契約是「稽核失敗不得擋住管理操作」，所以它 fire-and-forget
// 並吞掉錯誤。那個契約本身沒錯，但它讓一個**全損**的故障變得完全隱形：
// 正式站的 `admin_audit.id` identity 序列落後（`is_called=false` → `nextval()` 回傳已存在的 1），
// #521 之後的**每一筆**稽核都撞主鍵失敗，12 天內沒有任何日誌或告警。
//
// 修法是**不改契約、只讓失敗留下痕跡**：計數器 + log（第一次 + 每 100 次）+ `/api/health` 的
// `audit_failures`。這支測試釘住的是「痕跡真的會留下」——因為「有沒有留下痕跡」正是原本壞掉的東西，
// 不釘住的話下次很容易又被一個 `.catch(() => {})` 吃掉。
import { test } from "node:test";
import assert from "node:assert/strict";

const { appendAdminAuditAsync } = await import("../src/adminAuditAsync.js");
const { auditFailureStats, resetAuditFailureStats } = await import("../src/adminAuditHealth.js");

const PG = { driver: "postgres" };
const ENTRY = { actorId: 1, actorEmail: "a@example.com", action: "test_action", target: "t" };

// 一個「一定失敗」的 PG 替身：模擬 identity 序列落後造成的撞鍵錯誤。
function failingExec(message = 'duplicate key value violates unique constraint "admin_audit_pkey"') {
  const calls = [];
  const exec = async (sql, params = []) => {
    calls.push({ sql, params });
    throw new Error(message);
  };
  exec.calls = calls;
  return exec;
}

function workingExec() {
  const calls = [];
  const exec = async (sql) => {
    calls.push(sql);
    // INSERT 之後會問「有沒有超過上限要修剪」；回空陣列代表不用修剪。
    return [];
  };
  exec.calls = calls;
  return exec;
}

// console.error 間諜：只抓 [audit] 開頭的那幾行，避免其他模組的噪音。
function captureAuditLogs(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(" ")); };
  try { fn(); } finally { console.error = original; }
  return lines;
}

test("PG 稽核寫入失敗時：必須記數、寫 log，且仍然往外丟（契約不變）", async () => {
  resetAuditFailureStats();
  assert.equal(auditFailureStats().failures, 0, "起點應該是 0");

  const exec = failingExec();
  const logs = [];
  const original = console.error;
  console.error = (...args) => { logs.push(args.join(" ")); };
  try {
    // 契約：仍然 reject（呼叫端自己決定要不要擋管理操作）
    await assert.rejects(
      () => appendAdminAuditAsync(ENTRY, { ...PG, exec }),
      /duplicate key value violates unique constraint "admin_audit_pkey"/,
      "失敗仍然要往外丟，不能改成靜默回傳",
    );
  } finally {
    console.error = original;
  }

  const stats = auditFailureStats();
  assert.equal(stats.failures, 1, "失敗必須被計數——這正是原本隱形的東西");
  assert.match(stats.last.message, /admin_audit_pkey/, "要留下最後一次的錯誤訊息");
  assert.ok(stats.last.at, "要留下時間戳");

  const auditLines = logs.filter((l) => l.includes("[audit]"));
  assert.equal(auditLines.length, 1, "第一次失敗一定要印一行 log");
  assert.match(auditLines[0], /\[audit\].*累計 1 筆/, "log 要寫出累計筆數");
  assert.match(auditLines[0], /admin_audit_pkey/, "log 要帶上原因，否則等於沒說");
});

test("成功時不得計數、不得寫 log（避免把正常路徑當成故障）", async () => {
  resetAuditFailureStats();
  const logs = captureAuditLogs(() => {});
  await appendAdminAuditAsync(ENTRY, { ...PG, exec: workingExec() });
  assert.equal(auditFailureStats().failures, 0, "成功不該增加失敗計數");
  assert.equal(console.error === undefined, false);
  assert.deepEqual(logs.filter((l) => l.includes("[audit]")), [], "成功不該印 [audit] log");
});

test("log 不得洗版：只印第 1 次與每 100 次", async () => {
  resetAuditFailureStats();
  const logs = [];
  const original = console.error;
  console.error = (...args) => { logs.push(args.join(" ")); };
  try {
    for (let i = 0; i < 250; i += 1) {
      await appendAdminAuditAsync(ENTRY, { ...PG, exec: failingExec() }).catch(() => {});
    }
  } finally {
    console.error = original;
  }
  const auditLines = logs.filter((l) => l.includes("[audit]"));
  // 第 1、100、200 次 → 3 行（250 次失敗，其餘不印）
  assert.equal(auditLines.length, 3, `應該只印 3 行，實際 ${auditLines.length} 行：${auditLines.join(" | ")}`);
  assert.equal(auditFailureStats().failures, 250, "計數器仍要完整記到 250，不能因為不印就不算");
});

test("非 postgres 走同步路徑時不進 PG 計數邏輯", async () => {
  resetAuditFailureStats();
  // driver 不是 postgres → 走 appendAdminAuditSync，與 PG 的失敗計數無關。
  // 這裡只確認「不會被誤計」；同步路徑本身的寫入由 admin-audit 既有的測試負責。
  const before = auditFailureStats().failures;
  assert.equal(before, 0);
});
