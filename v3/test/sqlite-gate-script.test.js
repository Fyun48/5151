// sqlite-gate.sh 的離線自測（2026-10-09，SQLite 退場主線）。
//
// 不連任何 NAS：用 DRY_RUN=1 讓腳本只印出「將在遠端執行的指令序列」，再用字串斷言
// 驗證 on/off 的 .env 異動是「單一 key、mode 還原、count 檢查、值比對、compose 重建」，
// 且不會碰到 V3_IMAGE_PIN 或其他 key。同時斷言 `bash -n` 語法通過。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const v3Dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(v3Dir, "scripts", "sqlite-gate.sh");

function run(args, extraEnv = {}) {
  const r = spawnSync("bash", [scriptPath, ...args], {
    cwd: join(v3Dir, ".."),
    env: { ...process.env, DRY_RUN: "1", ...extraEnv },
    encoding: "utf8",
    timeout: 30_000,
  });
  // stdout 是遠端指令序列，stderr 是 [gate]/[rollback] 標頭。
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function countLiteral(s, needle) {
  return s.split(needle).length - 1;
}

test("bash -n 語法檢查通過", () => {
  assert.ok(existsSync(scriptPath), `找不到腳本：${scriptPath}`);
  const r = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
  assert.equal(r.status, 0, `bash -n 失敗：${r.stderr}`);
});

test("on 產生單一 key、mode 還原、count=1 的指令序列", () => {
  const r = run(["on", "591-tracker-v3"]);
  assert.equal(r.status, 0, `on 非零退出：${r.out}\n${r.err}`);
  // 單一 key：字面 PG_NO_SQLITE_OPEN 只出現一次（KEY= 指派那行），其餘都用 $KEY。
  assert.equal(countLiteral(r.out, "PG_NO_SQLITE_OPEN"), 1, "字面 key 應只出現一次");
  assert.match(r.out, /KEY='PG_NO_SQLITE_OPEN'/);
  assert.match(r.out, /VALUE='1'/);
  // 只改這一個 key：sed 的 pattern/replacement 都綁定 ${KEY}。
  assert.match(r.out, /sed -i "s\|\^\$\{KEY\}=\.\*\|\$\{KEY\}=\$\{VALUE\}\|"/);
  assert.match(r.out, /printf '%s=%s\\n' "\$KEY" "\$VALUE" >> "\$ENV_FILE"/);
  // mode 不變：先記 stat -c '%a'，異動後 chmod 還原。
  assert.match(r.out, /MODE="\$\(stat -c '%a' "\$ENV_FILE"\)"/);
  assert.match(r.out, /chmod "\$MODE" "\$ENV_FILE"/);
  // count=1 檢查＋值比對。
  assert.match(r.out, /if \[ "\$COUNT" != "1" \]/);
  assert.match(r.out, /grep -Fqx "\$\{KEY\}=\$\{VALUE\}"/);
  // 用容器 label 決定的 compose 檔重建。
  assert.match(r.out, /com\.docker\.compose\.project\.config_files/);
  assert.match(r.out, /docker compose "\$@" up -d/);
  // 不碰 V3_IMAGE_PIN（含錯字 V3_IMAGE_PICK）與其他 key。
  assert.doesNotMatch(r.out, /V3_IMAGE_PIN|V3_IMAGE_PICK/);
  assert.doesNotMatch(r.out, /(DB_DRIVER|PG_URL|R2_|OPS_|SESSION_SECRET)=/);
});

test("off 刪除 key、count=0，不碰其他 key", () => {
  const r = run(["off", "5151-web-B"]);
  assert.equal(r.status, 0, `off 非零退出：${r.out}\n${r.err}`);
  assert.equal(countLiteral(r.out, "PG_NO_SQLITE_OPEN"), 1);
  assert.match(r.out, /KEY='PG_NO_SQLITE_OPEN'/);
  assert.match(r.out, /sed -i "\/\^\$\{KEY\}=\/d"/);
  assert.match(r.out, /if \[ "\$COUNT" != "0" \]/);
  assert.match(r.out, /chmod "\$MODE" "\$ENV_FILE"/);
  assert.match(r.out, /docker compose "\$@" up -d/);
  assert.doesNotMatch(r.out, /V3_IMAGE_PIN|V3_IMAGE_PICK/);
  assert.doesNotMatch(r.out, /(DB_DRIVER|PG_URL|R2_|OPS_|SESSION_SECRET)=/);
});

test("不給 target 時 on/off 三台都做", () => {
  const onAll = run(["on"]);
  assert.equal(onAll.status, 0, `on all 非零退出：${onAll.out}`);
  for (const t of ["591-tracker-v3", "5151-web-A", "5151-web-B"]) {
    assert.ok(
      onAll.err.includes(t),
      `on all 應該涵蓋 ${t}，stderr=${onAll.err}`
    );
  }
  const offAll = run(["off"]);
  assert.equal(offAll.status, 0, `off all 非零退出：${offAll.out}`);
});

test("rollback 是 off 的別名並印出三個下一步指令", () => {
  const r = run(["rollback"]);
  assert.equal(r.status, 0, `rollback 非零退出：${r.out}\n${r.err}`);
  // 走的是 off 邏輯（刪 key）。
  assert.match(r.out, /sed -i "\/\^\$\{KEY\}=\/d"/);
  // 三個下一步指令（print_rollback_next 走 stdout）。
  assert.match(r.out, /sqlite-gate\.sh status/);
  assert.match(r.out, /curl -fsS https:\/\/jibbyrenth\.reversalplay\.me\/api\/health/);
  assert.match(r.out, /business SQLite is closed/);
});

test("status 唯讀：不印 .env 內容、只印 key 名與 digest/mtime 欄位", () => {
  const r = run(["status"]);
  assert.equal(r.status, 0, `status 非零退出：${r.out}\n${r.err}`);
  // 只查 PG_NO_SQLITE_OPEN 這一個 key，且輸出欄位不含任何 .env 內容欄位。
  assert.match(r.out, /grep '\^PG_NO_SQLITE_OPEN='/);
  assert.match(r.out, /echo "container=\$CONTAINER pg_no_sqlite_open=\$VAL image=\$IMG wal_mtime=\$MT"/);
  assert.doesNotMatch(r.out, /(DB_DRIVER|PG_URL|R2_|OPS_|SESSION_SECRET)=/);
});

test("未知 target 明確失敗", () => {
  const r = run(["on", "nope"]);
  assert.notEqual(r.status, 0, "未知 target 應非零退出");
});
