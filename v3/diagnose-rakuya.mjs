// Run inside the v3 container: node v3/diagnose-rakuya.mjs
// Read-only database inspection plus one public Rakuya list request. No retries,
// imports, notification delivery, pagination, or challenge bypass.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fetchRakuyaListPage, rakuyaListUrl } from "./src/rakuya.js";

const db = new DatabaseSync(path.join(process.env.DATA_DIR || "data-v3", "v3.db"), { readOnly: true });
const stored = Object.fromEntries(["rakuya", "housefun", "ddroom"].map(source => [source, 0]));
try {
  for (const row of db.prepare("SELECT source, COUNT(*) AS n FROM listings WHERE source IN ('rakuya', 'housefun', 'ddroom') GROUP BY source").all()) {
    stored[row.source] = Number(row.n);
  }
} finally { db.close(); }

const url = rakuyaListUrl({ regionId: 1, page: 1 });
const started = Date.now();
let httpStatus = null;
let bytes = 0;
let result;
try {
  result = await fetchRakuyaListPage({ url, fetchText: async target => {
    const response = await fetch(target, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", Accept: "text/html" },
      signal: AbortSignal.timeout(15000),
    });
    httpStatus = response.status;
    const text = await response.text();
    bytes = Buffer.byteLength(text);
    return { status: response.status, text };
  } });
} catch (error) {
  result = { ok: false, code: error.name === "TimeoutError" ? "TIMEOUT" : "FETCH_FAILED", message: error.message };
}
console.log(JSON.stringify({ checked_at: new Date().toISOString(), stored,
  rakuya: { url, http_status: httpStatus, response_bytes: bytes, elapsed_ms: Date.now() - started,
    ok: result.ok, code: result.code || (result.ok ? "SUCCESS" : "FETCH_FAILED"),
    message: result.message || "", parsed_records: result.items?.length || 0 } }, null, 2));
