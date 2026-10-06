// R1：mrt_cache 的「來源／演算法版本／查證狀態」契約。
//
// 為什麼要單獨一支：這一條驗的是**真的 db.js**（暫存 DATA_DIR、真的 SQLite 檔），
// 不是純函式。舊的車用 profile 值就是在這裡被擋掉的 —— 沒有這一條，
// 「換服務但舊值繼續被當成已查證」的缺口不會被任何測試抓到。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MRT_CACHE_CONTRACT } from "../src/mrt.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href);
const mrtUrl = JSON.stringify(pathToFileURL(path.join(dir, "../src/mrt.js")).href);

function run(script) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-mrt-contract-"));
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("R1：舊列（source 空／checked 0）不算已查證；新列才讀得到，且 0 公尺保留", () => {
  const out = run(`
    const app = await import(${dbUrl});
    const { MRT_CACHE_CONTRACT, makeMrtKey } = await import(${mrtUrl});
    const key = makeMrtKey(25.31, 121.71);
    const db = app.sqliteHandle();
    const stamp = "2026-10-01T00:00:00.000Z";
    // 1) 舊格式：只有 walk_km，沒有來源／查證欄位（＝切換 profile 之前寫進去的車用值）
    db.prepare("INSERT INTO mrt_cache(geo_key, station, walk_km, walk_min, ride_km, ride_min, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(key, "士林", 0.4, 6, null, null, stamp);
    const legacyRead = app.getCachedMrt(25.31, 121.71);

    // 2) 新格式：帶契約來源與原始公尺
    app.setCachedMrt(25.40, 121.80, { resolved: true, station: "士林", walk_m: 412.5, searched_m: 1000, source: MRT_CACHE_CONTRACT });
    const fresh = app.getCachedMrt(25.40, 121.80);

    // 3) 0 公尺（查詢點與站點出入口重合）必須保留，不可以變成 null
    app.setCachedMrt(25.41, 121.81, { resolved: true, station: "士林", walk_m: 0, searched_m: 1000, source: MRT_CACHE_CONTRACT });
    const zero = app.getCachedMrt(25.41, 121.81);

    // 4) 沒有契約來源的寫入會被標成未查證
    app.setCachedMrt(25.42, 121.82, { resolved: true, station: "士林", walk_km: 0.3 });
    const unverified = app.getCachedMrt(25.42, 121.82);

    // 5) 缺值必須維持 NULL，不可以被寫成 0（Number(null) === 0）
    //    「沒有距離」寫成 0 公尺，讀回來就變成「0 公尺 ⇒ 符合」。
    //    （註：子腳本在樣板字串裡，這裡不能出現反引號。）
    app.setCachedMrt(25.43, 121.83, {
      resolved: true, station: "", walk_m: null, walk_km: null, searched_m: null, source: MRT_CACHE_CONTRACT,
    });
    const raw = db.prepare("SELECT station, walk_km, walk_min, ride_km, ride_min, walk_m, searched_m, checked, source FROM mrt_cache WHERE geo_key = ?")
      .get(makeMrtKey(25.43, 121.83));
    const noneRead = app.getCachedMrt(25.43, 121.83);

    console.log(JSON.stringify({
      legacyRead,
      fresh,
      zero,
      unverified,
      rawNulls: { walk_km: raw?.walk_km ?? null, walk_m: raw?.walk_m ?? null, searched_m: raw?.searched_m ?? null, ride_km: raw?.ride_km ?? null, checked: raw?.checked ?? null },
      noneWalkM: noneRead ? noneRead.walk_m : "no-row",
      noneWalkKm: noneRead ? noneRead.walk_km : "no-row",
      contract: MRT_CACHE_CONTRACT,
    }));
  `);
  assert.equal(out.legacyRead, null, "舊的車用 profile 列必須被當成「沒有快取」");
  assert.ok(out.fresh, "有契約來源的列才讀得到");
  assert.equal(out.fresh.walk_m, 412.5, "原始公尺要原樣保留（不可以在寫入時四捨五入）");
  assert.equal(out.fresh.walk_km, 0.4);
  assert.equal(out.fresh.source, out.contract);
  assert.ok(out.zero, "0 公尺是合法距離");
  assert.equal(out.zero.walk_m, 0);
  assert.equal(out.zero.walk_km, 0);
  assert.equal(out.unverified, null, "沒有契約來源的寫入不可以被當成已查證");
  // 缺值保持 NULL：欄位裡是 null，讀出來也是 null（不是 0）
  assert.equal(out.rawNulls.walk_m, null, "walk_m 缺值要存成 NULL，不是 0");
  assert.equal(out.rawNulls.walk_km, null, "walk_km 缺值要存成 NULL，不是 0");
  assert.equal(out.rawNulls.searched_m, null, "searched_m 缺值要存成 NULL，不是 0");
  assert.equal(out.rawNulls.ride_km, null, "ride_km 缺值要存成 NULL，不是 0");
  assert.equal(out.noneWalkM, null, "讀回來的 walk_m 要是 null（不可以變成 0 公尺）");
  assert.equal(out.noneWalkKm, null);
});

test("R1：背景掃描只把「已查證」的座標當成不必重算", () => {
  const out = run(`
    const app = await import(${dbUrl});
    const { MRT_CACHE_CONTRACT, makeMrtKey } = await import(${mrtUrl});
    const db = app.sqliteHandle();
    const stamp = "2026-10-01T00:00:00.000Z";
    db.prepare("INSERT INTO mrt_cache(geo_key, station, walk_km, walk_min, ride_km, ride_min, updated_at, source, checked, walk_m, searched_m) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(makeMrtKey(25.50, 121.90), "士林", 0.4, 6, null, null, stamp, MRT_CACHE_CONTRACT, 1, 400, 1000);
    db.prepare("INSERT INTO mrt_cache(geo_key, station, walk_km, walk_min, ride_km, ride_min, updated_at, source, checked, walk_m, searched_m) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(makeMrtKey(25.51, 121.91), "士林", 0.4, 6, null, null, stamp, "", 0, null, null);
    const sqliteKeys = new Set([makeMrtKey(25.50, 121.90), makeMrtKey(25.51, 121.91)]
      .filter((k, i) => Boolean(app.getCachedMrt(i === 0 ? 25.50 : 25.51, i === 0 ? 121.90 : 121.91))));
    const { sql, params } = app.mrtCacheKeysQuery();
    console.log(JSON.stringify({ sql, params, sqliteKeys: [...sqliteKeys] }));
  `);
  // 掃描用的查詢必須自己帶契約條件（PG 路徑靠這一句，不是靠 JS 過濾）
  assert.match(out.sql, /checked\s*=\s*1/);
  assert.match(out.sql, /source\s*=\s*\?/);
  assert.deepEqual(out.params, [MRT_CACHE_CONTRACT]);
  // SQLite 路徑：只有已查證的那個座標被視為已有快取
  assert.deepEqual(out.sqliteKeys, ["25.5,121.9"]);
});
