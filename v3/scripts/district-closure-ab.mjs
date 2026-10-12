// #740 的新口徑對照：`list_prepare_ms`（閉包坐在這裡）／`list;dur`／`wall`，
// 以及「增量吸收會不會拖慢觸發它的那一個請求」。
//
//   node v3/scripts/district-closure-ab.mjs --mode ab [--runs 3] [--uid 2] [--json]
//   node v3/scripts/district-closure-ab.mjs --mode absorb-trigger [--runs 6] [--json]
//
// 兩側都用**同一個入口**（`loadListingPage` ＝ HTTP `/api/listings` 走的那條），同一份資料、
// 同一個請求參數；A 側＝`MEMBER_DISTRICT_CLOSURE_MATERIALIZED=0`（逐字即時算），B 側＝預設 ON。
//
// 只在自建隔離庫上跑（會建立／覆寫本功能的衍生表）：PG_URL=<隔離庫> DB_DRIVER=postgres
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";

process.env.DATA_DIR ||= "/tmp/dc3-ab";
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};
const mode = String(flag("mode", "ab"));
const runs = Math.max(1, Number(flag("runs", 3)) || 3);
const uid = Number(flag("uid", 2)) || 2;
const asJson = argv.includes("--json");
const URL_ = String(process.env.PG_URL || process.env.PG_LIVE_REPRO_URL || "").trim();
if (!URL_) { console.error("需要 PG_URL（自建隔離庫）"); process.exit(2); }
const dbName = assertPgTargetAllowed("district-closure-ab", URL_);
process.env.DB_DRIVER = process.env.DB_DRIVER || "postgres";
process.env.PG_URL = URL_;

const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
const { ensureMatchComponentsOnce, rebuildMatchComponents, absorbMatchComponentDelta } = await import("../src/repository/writePath.js");
const { sharedPgDriver } = await import("../src/pgSharedDriver.js");
const { buildListRequestContextFromPg } = await import("../src/db.js");

const admin = await createPostgresDriver({ connectionString: URL_ });
const q = (sql, params = []) => admin.query(toPostgresSql(sql), params);
const exec = async (sql, params = []) => (await q(sql, params)).rows;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const sorted = (ids) => [...(ids || [])].sort((a, b) => a - b);

const pg = await sharedPgDriver();
const pgExec = (sql, params = []) => pg.query(toPostgresSql(sql), params).then((r) => r.rows);

const { loadListingPage } = await import("../src/listingSearchPage.js");

/**
 * 一次請求：**同一個入口**（`loadListingPage` ＝HTTP `/api/listings` 走的那條），
 * 回傳新口徑的三個數字＋逐項可比的欄位。
 */
async function oneRequest({ args = {} } = {}) {
  const probe = await buildListRequestContextFromPg(pgExec, { asOf: null, resolvedSearchKeys: undefined });
  const settings = probe.settingsForUser(uid);
  const started = performance.now();
  const page = await loadListingPage({
    filter: "all", kind: "", sources: "", q: "", limit: 20, offset: 0,
    userId: uid, matchVoteUserId: uid, sameHouse: true, settings, ...args,
  }, { driver: "postgres", pgDriver: pg });
  const wall = performance.now() - started;
  const timing = page.timing || {};
  return {
    listPrepareMs: timing.stats_stages?.list_prepare_ms ?? null,
    listDurMs: Number(timing.query_ms ?? 0),
    wallMs: Number(wall.toFixed(1)),
    // 逐項可比的欄位（L-0845：兩側都要列出來，空集合也要比）
    matched: page.stats?.matched ?? null,
    total: page.stats?.total ?? null,
    excludedByCommute: page.stats?.excludedByCommute ?? null,
    commutePending: page.stats?.commutePending ?? null,
    ids: (page.listings || []).map((row) => Number(row.post_id)),
  };
}

const report = { db: dbName, mode, uid, runs };
try {
  await ensureMatchComponentsOnce(admin);
  if (mode === "ab") {
    await rebuildMatchComponents(admin, { reason: "ab-bootstrap", force: true });
    const args = { districts: ["中山區"], sort: "newest", limit: 20 };
    const runSide = async (label) => {
      const warm = await oneRequest({ args });
      const out = [];
      for (let i = 0; i < runs; i += 1) out.push(await oneRequest({ args }));
      return { label, warm, runs: out, ids: sorted(out[out.length - 1].ids) };
    };
    process.env.MEMBER_DISTRICT_CLOSURE_MATERIALIZED = "0";
    const off = await runSide("off");
    process.env.MEMBER_DISTRICT_CLOSURE_MATERIALIZED = "1";
    const on = await runSide("on");
    const pick = (side, key) => median(side.runs.map((row) => row[key]));
    const last = (side) => side.runs[side.runs.length - 1];
    report.off = { list_prepare_ms: pick(off, "listPrepareMs"), "list;dur": pick(off, "listDurMs"), wall: pick(off, "wallMs"), items: last(off) };
    report.on = { list_prepare_ms: pick(on, "listPrepareMs"), "list;dur": pick(on, "listDurMs"), wall: pick(on, "wallMs"), items: last(on) };
    report.delta = {
      list_prepare_ms: Number((report.off.list_prepare_ms - report.on.list_prepare_ms).toFixed(1)),
      "list;dur": Number((report.off["list;dur"] - report.on["list;dur"]).toFixed(1)),
      wall: Number((report.off.wall - report.on.wall).toFixed(1)),
      list_prepare_drop_pct: Number((((report.off.list_prepare_ms - report.on.list_prepare_ms) / report.off.list_prepare_ms) * 100).toFixed(1)),
    };
    const onlyOff = report.off.items.ids.filter((id) => !report.on.items.ids.includes(id));
    const onlyOn = report.on.items.ids.filter((id) => !report.off.items.ids.includes(id));
    report.identical = {
      matched: report.off.items.matched === report.on.items.matched,
      total: report.off.items.total === report.on.items.total,
      excludedByCommute: report.off.items.excludedByCommute === report.on.items.excludedByCommute,
      commutePending: report.off.items.commutePending === report.on.items.commutePending,
      ids: onlyOff.length === 0 && onlyOn.length === 0,
      onlyOff, onlyOn,
      allSame: report.off.items.matched === report.on.items.matched
        && report.off.items.total === report.on.items.total
        && report.off.items.excludedByCommute === report.on.items.excludedByCommute
        && report.off.items.commutePending === report.on.items.commutePending
        && onlyOff.length === 0 && onlyOn.length === 0,
    };
  } else if (mode === "absorb-trigger") {
    // 「吸收會不會拖慢觸發它的那一個請求」：讀取端只**排程**（fire-and-forget），
    // 這裡量三件事：(1) 請求自身耗時；(2) 排程函式回傳到吸收真正開始的延遲；
    // (3) 同一個請求在「吸收被停用」與「啟用」下的 list_prepare_ms 差。
    await rebuildMatchComponents(admin, { reason: "absorb-bootstrap", force: true });
    const { scheduleMatchComponentAbsorb, resetAbsorbScheduleForTest } = await import("../src/listingMatchComponents.js");
    const args = { districts: ["中山區"], sort: "newest", limit: 20 };
    const rows = [];
    for (let i = 0; i < runs; i += 1) {
      // 造一條純新增邊 + bump（照正式寫入端），讓下一個請求的證明會**命中 overlay** 並排一次吸收
      const free = await exec("SELECT post_id FROM listings WHERE COALESCE(match_post_id, 0) = 0 AND post_id > 0 ORDER BY post_id LIMIT 1 OFFSET $1", [i]);
      const target = await exec("SELECT post_id FROM listings WHERE match_post_id > 0 OR match_post_id < 0 ORDER BY post_id LIMIT 1");
      const from = Number(free[0]?.post_id) || 0;
      const to = Number(target[0]?.post_id) || 0;
      await exec("UPDATE listings SET match_post_id = $1 WHERE post_id = $2", [to, from]);
      await exec("INSERT INTO data_revision (entity_type, entity_id, event_type, created_at) VALUES ('listing', $1, 'same_house_match', $2)", [from, Date.now()]);
      const scheduledAt = [];
      const startedAt = [];
      const t0 = performance.now();
      // 攔截排程：記錄「請求呼叫排程」的時刻與「吸收真的開始」的時刻（吸收本體由排程器在 timer 後呼叫）
      const realSchedule = scheduleMatchComponentAbsorb;
      const result = await (async () => {
        const { loadMaterializedDistrictClosure } = await import("../src/listingMatchComponents.js");
        const wrapped = (payload) => { scheduledAt.push(performance.now() - t0); return realSchedule(payload); };
        const probe = await q("SELECT 1");
        void probe;
        const ids = await loadMaterializedDistrictClosure(pgExec, {
          allowed: (await import("../src/listDistrictSql.js")).districtKeyLists(["中山區"]).allowed,
          allKeys: (await import("../src/listDistrictSql.js")).districtKeyLists(["中山區"]).allKeys,
          userId: 0, relatedOnly: false, absorbState: wrapped,
        });
        return ids;
      })();
      const requestMs = performance.now() - t0;
      // 等吸收跑完（背景；timer 250ms + 查詢）
      let absorbDone = null;
      const waitStart = performance.now();
      while (performance.now() - waitStart < 5000) {
        const state = await exec(
          "SELECT revision_watermark FROM listing_match_component_state WHERE state_key = 'match_graph'",
        );
        const rev = await exec("SELECT COALESCE(MAX(id),0) AS r FROM data_revision");
        if (Number(state[0]?.revision_watermark) >= Number(rev[0]?.r)) { absorbDone = performance.now() - waitStart; break; }
        await new Promise((r) => setTimeout(r, 50));
      }
      rows.push({
        scheduledAtMs: Number(scheduledAt[0]?.toFixed(1)),
        requestMs: Number(requestMs.toFixed(1)),
        absorbFinishedAfterMs: absorbDone == null ? null : Number(absorbDone.toFixed(1)),
        materialized: Array.isArray(result),
      });
      resetAbsorbScheduleForTest();
    }
    report.trigger = {
      samples: rows,
      scheduledInsideRequestMs: median(rows.map((r) => r.scheduledAtMs)),
      requestMs: median(rows.map((r) => r.requestMs)),
      absorbFinishedAfterMs: median(rows.map((r) => r.absorbFinishedAfterMs ?? 0)),
    };
  }
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else console.log(JSON.stringify(report));
  const ok = mode === "ab" ? report.identical.allSame === true : true;
  console.log(ok ? "OK" : "FAIL");
  process.exit(ok ? 0 : 1);
} finally {
  await admin.close();
}
