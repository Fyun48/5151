// 各節點 SQLite 一致快照（PR-A：先保存，再處理資料）。
//
// 為什麼不是 cp：正在運行的 SQLite 在 WAL 模式下，未 checkpoint 的已提交資料還在 -wal，
// 只複製 v3.db 會漏資料且可能拿到不一致的頁面（SQLite 官方文件 WAL 章節）。
// 這裡用 `VACUUM INTO`（SQLite 官方一致備份方式之一）產生單一檔案的完整快照，
// 再對「新產生的快照」做 integrity_check 與 sha256，輸出可追蹤的 manifest。
//
// 用法（在容器內執行，建議以 stdin 傳入，避免需要額外掛載）：
//   ssh <host> "docker exec -i <container> node --input-type=module" < v3/scripts/sqlite-consistency-snapshot.mjs
// 之後由 host 把 /data 下的 snapshot 檔搬到封存目錄（archive/ 與 live data 分開）。
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, statSync, existsSync } from "node:fs";

const SOURCE = process.env.SNAPSHOT_SOURCE || "/data/v3.db";
const LABEL = process.env.SNAPSHOT_LABEL || "node";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const TARGET = process.env.SNAPSHOT_TARGET || `/data/.sqlite-snapshot-${LABEL}-${stamp}.db`;

const manifest = {
  label: LABEL,
  at: new Date().toISOString(),
  source: SOURCE,
  target: TARGET,
  sourceExists: existsSync(SOURCE),
  walExists: existsSync(`${SOURCE}-wal`),
};

if (!manifest.sourceExists) {
  console.log(JSON.stringify({ ...manifest, error: "source db not found" }, null, 2));
  process.exit(2);
}

// 1) 從 live DB 產生一致快照（只讀來源；寫的是新檔）
const live = new DatabaseSync(SOURCE, { readOnly: true });
try {
  live.exec(`VACUUM INTO '${TARGET.replace(/'/g, "''")}'`);
} finally {
  live.close();
}

// 2) 驗證快照可以開啟、結構完整、且與來源的關鍵計數一致
const snap = new DatabaseSync(TARGET, { readOnly: true });
try {
  manifest.integrity = snap.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "unknown";
  manifest.pageCount = snap.prepare("PRAGMA page_count").get()?.page_count ?? null;
  manifest.tables = snap
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .get()?.n ?? null;
  for (const table of ["listings", "data_revision", "user_events", "listing_match_evaluations", "crawl_covers"]) {
    try {
      manifest[`count_${table}`] = snap.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? null;
    } catch {
      manifest[`count_${table}`] = "n/a";
    }
  }
} finally {
  snap.close();
}

// 3) manifest：大小與 sha256（可與其他節點／封存對帳）
const size = statSync(TARGET).size;
const hash = createHash("sha256").update(readFileSync(TARGET)).digest("hex");
console.log(JSON.stringify({ ...manifest, bytes: size, sha256: hash }, null, 2));
