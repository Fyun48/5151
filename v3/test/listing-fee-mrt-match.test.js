// R2：**一筆真實的站內刊登**能不能在費用與捷運兩個新條件上，跑出真正的
// 「符合／不符合／未確認」三種結果。
//
// 這一條刻意用**真的 db.js**（暫存 DATA_DIR、真的 SQLite 檔）與真的寫入 API，
// 不用手寫 snapshot —— 因為要驗的正是「屋主填的資料有沒有真的落到房源列上、
// 配對有沒有讀到它」。手寫 snapshot 的測試會漏掉中間那一段。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href);
const matchUrl = JSON.stringify(pathToFileURL(path.join(dir, "../src/rentalMatch.js")).href);

function run(script) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-fee-mrt-match-"));
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 90_000,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const BASE_LISTING = `
  district: "1-8", rent: 25000, ping: 18, kind: "whole", role: "owner",
  floor: 3, total_floors: 5, rooms: 2, living: 1, bath: 1, contact_name: "林先生",
  address: "台北市士林區中正路100號", phone: "0912345678",
  title: "士林整層可看屋", body: "近捷運、可入住、有洗衣機。", accept_pledge: true,
`;
const BASE_WISH = `
  districts: ["1-8"], rent_max: 30000, housing_type: "whole", ping_min: 12, layout: "2",
  body: "想要近捷運、租金含水電的兩房。", mrt_walk: 1,
`;

test("R2：一筆真實站內刊登可以跑出費用的符合／不符合／未確認", () => {
  const out = run(`
    const app = await import(${dbUrl});
    const { listingMatchSnapshot, wishMatchSnapshot, evaluateMatch } = await import(${matchUrl});
    const db = app.sqliteHandle();

    // 屋主：三個房東，分別填「已含」「另計」「沒填」
    db.prepare("INSERT INTO users(id, email, created_at) VALUES (101,'owner1@example.com','2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO users(id, email, created_at) VALUES (102,'owner2@example.com','2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO users(id, email, created_at) VALUES (103,'owner3@example.com','2026-01-01T00:00:00.000Z')").run();

    const mk = (uid, extra) => app.createSelfListing(uid, { ${BASE_LISTING} ...extra });
    const included = mk(101, { fee_includes: { utilities: "included" }, lat: 25.033, lng: 121.565, geo_source: "self",
      mrt_state: "within", mrt_station: "台北101/世貿", mrt_walk_m: 620, mrt_source: "osrm-foot:v1" });
    const extraFee = mk(102, { fee_includes: { utilities: "extra" } });
    const unknown = mk(103, {});

    // 租客：要水電 + 1 公里內步行捷運
    db.prepare("INSERT INTO users(id, email, created_at) VALUES (109,'renter@example.com','2026-01-01T00:00:00.000Z')").run();
    const wish = app.createDemand(109, { ${BASE_WISH} fee_includes: ["utilities"] });

    const rows = (id) => db.prepare("SELECT * FROM listings WHERE post_id=?").get(id);
    const wishRow = db.prepare("SELECT * FROM demand_posts WHERE id=?").get(wish.id);
    const snap = (id) => listingMatchSnapshot(rows(id));
    const w = wishMatchSnapshot(wishRow);
    const judge = (id) => {
      const r = evaluateMatch(snap(id), w);
      return { eligible: r.eligible, matched: r.matched_conditions, unmet: r.unmet_unknowns, hard: r.hard_conflicts.map((x) => x.code) };
    };
    console.log(JSON.stringify({
      wishMrtNeeded: w.mrt_walk,
      wishFees: w.fee_includes,
      listingFeeState: snap(included.id ?? included.post_id).fee_state,
      included: judge(included.post_id),
      extraFee: judge(extraFee.post_id),
      unknown: judge(unknown.post_id),
    }));
  `);
  // 屋主填「已含」且步行 620 公尺 ⇒ 兩個條件都真的符合
  assert.ok(out.included.matched.includes("fee:utilities"), `費用應該符合：${JSON.stringify(out.included)}`);
  assert.ok(out.included.matched.includes("mrt_walk"), `捷運應該符合：${JSON.stringify(out.included)}`);
  assert.equal(out.included.eligible, true);
  // 屋主填「另計」⇒ 硬衝突（不是未確認）
  assert.ok(out.extraFee.hard.includes("fee:utilities"), `另計要是硬衝突：${JSON.stringify(out.extraFee)}`);
  assert.equal(out.extraFee.eligible, false);
  // 沒填 ⇒ 未確認（既不是符合，也不是衝突）
  assert.ok(out.unknown.unmet.includes("fee:utilities"), `沒填要是未確認：${JSON.stringify(out.unknown)}`);
  assert.ok(out.unknown.unmet.includes("mrt_walk"));
  assert.equal(out.unknown.hard.includes("fee:utilities"), false);
  assert.equal(out.unknown.eligible, true);
});

test("R2：已查證超過 1 公里的房源在配對上是「不符合」，不是「未確認」", () => {
  const out = run(`
    const app = await import(${dbUrl});
    const { listingMatchSnapshot, wishMatchSnapshot, evaluateMatch } = await import(${matchUrl});
    const db = app.sqliteHandle();
    db.prepare("INSERT INTO users(id, email, created_at) VALUES (101,'owner1@example.com','2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO users(id, email, created_at) VALUES (109,'renter@example.com','2026-01-01T00:00:00.000Z')").run();
    // 1,049 公尺：顯示會四捨五入成 1.0 公里，但判定必須是不符合
    const far = app.createSelfListing(101, { ${BASE_LISTING} lat: 25.072, lng: 121.548, geo_source: "self",
      mrt_state: "outside", mrt_station: "", mrt_walk_m: null, mrt_nearest_m: 1049, mrt_source: "osrm-foot:v1" });
    const wish = app.createDemand(109, { ${BASE_WISH} fee_includes: [] });
    const row = db.prepare("SELECT * FROM listings WHERE post_id=?").get(far.post_id);
    const w = wishMatchSnapshot(db.prepare("SELECT * FROM demand_posts WHERE id=?").get(wish.id));
    const snap = listingMatchSnapshot(row);
    const r = evaluateMatch(snap, w);
    console.log(JSON.stringify({ walk_m: snap.mrt_walk_m, nearest_m: snap.mrt_nearest_m, state: snap.mrt_state, eligible: r.eligible, hard: r.hard_conflicts.map((x) => x.code) }));
  `);
  assert.equal(out.state, "outside", "查證狀態要持久化成 outside（不是掉回 unknown）");
  assert.equal(out.nearest_m, 1049, "「最近但超過」也要保留未四捨五入的公尺");
  assert.equal(out.eligible, false, "1,049 公尺不可以算符合");
  assert.ok(out.hard.includes("mrt_walk"), "要產生硬衝突，不是未確認");
});
