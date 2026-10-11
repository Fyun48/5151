// 591 補座標掃描的「輪轉起點」（`v3/src/geo591Cursor.js`）。
//
// 這一支要釘住三件事：
//   1. 起點在正式庫的鍵段內、而且是 **bigint 安全**的：正式 `max(post_id)=2,699,975,575` 超過
//      2^31-1，用 32 位元亂數（`| 0`／`Int32Array`／`Math.floor(Math.random() * 2 ** 31)`）只涵蓋到
//      2^31-1，2^31 以上的鍵段會永遠只從 0 開始 ⇒ 高 post_id 的欠補列排不到。這裡用注入位元組的
//      方式直接證明「2^31 的值原樣過關」，而不是靠抽樣運氣。
//   2. `GEO591_CURSOR_SEED` 設了就逐字使用（量測／測試要可重現）；沒設才隨機。
//   3. 換起點不影響覆蓋性：不同起點跑完整個循環，欠補列的集合都要被走遍、而且游標單調前進、
//      掃到結尾歸零。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GEO591_KEY_CAP,
  GEO591_SEED_BYTES,
  geo591CursorStart,
  nextGeo591Cursor,
  randomGeo591CursorStart,
} from "../src/geo591Cursor.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-geo591-cursor-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while the process holds it.
  }
});

const app = await import("../src/db.js");
const { geo591RotationQuery } = app;
const handle = app.sqliteHandle();

const CACHED_COMMUNITY = 6100;
// 25 列欠補（缺座標／社區未快取）交錯在 962001..962060，加上少數「不需要補」的列當干擾。
const NEEDY_IDS = [];
for (let i = 0; i < 25; i += 1) NEEDY_IDS.push(962001 + i * 2);
const NOT_NEEDY_IDS = [962050, 962052];
const UNCACHED_COMMUNITY = 6200;

function seedFixture() {
  const insert = handle.prepare(
    `INSERT INTO listings(post_id, source_key, title, url, first_seen_at, last_seen_at,
                          lat, lng, geo_source, community_id, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '591')`,
  );
  const stamp = "2026-01-01T00:00:00.000Z";
  for (const id of NEEDY_IDS) {
    // 一半缺座標、一半缺社區快取（兩條下推腿各有一半的樣本）。
    const missingCoords = id % 4 === 1;
    insert.run(
      id, `9|9|c9${id}`, `needy-${id}`, `https://example.test/${id}`, stamp, stamp,
      missingCoords ? null : 25.03, missingCoords ? null : 121.56,
      missingCoords ? "" : "591",
      missingCoords ? 0 : UNCACHED_COMMUNITY,
    );
  }
  for (const id of NOT_NEEDY_IDS) {
    insert.run(id, `9|9|c${CACHED_COMMUNITY}`, `ok-${id}`, `https://example.test/${id}`, stamp, stamp, 25.03, 121.56, "591", CACHED_COMMUNITY);
  }
  handle.prepare(
    "INSERT INTO community_cache(community_id, name, address, lat, lng, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(CACHED_COMMUNITY, `c${CACHED_COMMUNITY}`, "台北市", 25.03, 121.56, stamp);
}

seedFixture();

const ids = (rows) => rows.map((row) => Number(row.post_id));

// 模擬 `backfillListingCoords()` ＋ server 的「一輪 80 次、回 0 列就 break」：
// 回 0 列時游標歸零（＝下一次 queueGeoBackfill 從 0 開始），所以第二段會把起點以下的列走完。
function runCycle(startId, limit = 7) {
  const seen = [];
  const segments = [];
  let cursor = startId;
  let wrapped = false;
  for (let round = 0; round < 200; round += 1) {
    const query = geo591RotationQuery({ limit, cursor });
    const rows = handle.prepare(query.sql).all(...query.params);
    if (!rows.length) {
      if (wrapped) return { seen, segments, rounds: round + 1 };
      wrapped = true;
      cursor = nextGeo591Cursor(rows); // = 0
      continue;
    }
    const batch = ids(rows);
    for (let i = 1; i < batch.length; i += 1) {
      assert.ok(batch[i] > batch[i - 1], `同一批必須是 post_id 遞增（${batch[i - 1]} → ${batch[i]}）`);
    }
    if (cursor > 0) assert.ok(batch[0] > cursor, "下一批必須接在游標之後（單調前進）");
    seen.push(...batch);
    segments.push(batch);
    const next = nextGeo591Cursor(rows);
    assert.ok(next >= batch[batch.length - 1], "游標不可以倒退");
    cursor = next;
  }
  throw new Error("循環沒有收斂（游標沒有前進或沒有歸零）");
}

test("GEO591_CURSOR_SEED 設了就逐字使用（含超過 2^31-1 的 post_id）", () => {
  assert.equal(geo591CursorStart({ env: { GEO591_CURSOR_SEED: "0" } }), 0);
  assert.equal(geo591CursorStart({ env: { GEO591_CURSOR_SEED: "962013" } }), 962013);
  // 正式庫實測 max(post_id)：2,699,975,575 > 2^31-1 = 2,147,483,647
  assert.equal(geo591CursorStart({ env: { GEO591_CURSOR_SEED: "2699975575" } }), 2699975575);
  assert.ok(2699975575 > 2 ** 31 - 1, "測試前提：這個種子必須真的超過 2^31-1");
  // 前後空白要容忍（.env 常見）
  assert.equal(geo591CursorStart({ env: { GEO591_CURSOR_SEED: " 962013 " } }), 962013);
});

test("種子不合法時退回隨機起點（而且不是靜默忽略）", () => {
  const bad = ["abc", "-1", "1.5", "1e9", "0x10", ""];
  for (const seed of bad) {
    // 注入固定的位元組 ⇒ 隨機那條路可預期。
    const got = geo591CursorStart({ env: { GEO591_CURSOR_SEED: seed }, bytes: Buffer.from([0, 0, 128, 0, 0, 0]) });
    assert.equal(got, 2147483648, `seed=${JSON.stringify(seed)} 應該退回隨機起點`);
  }
  // 空字串＝沒設 ⇒ 隨機（不是 0）
  assert.notEqual(geo591CursorStart({ env: {}, bytes: Buffer.from([0, 0, 1, 0, 0, 0]) }), 0);
});

test("隨機起點是 bigint 安全的：2^31 以上的值原樣保留、不會被截斷或折成負數", () => {
  assert.equal(GEO591_SEED_BYTES, 6, "亂數至少要 6 位元組（48 位元）才涵蓋得到 2^31 以上的鍵段");
  const cases = [
    [0, 0, 128, 0, 0, 0], // 2^31（`| 0` 會變成 -2147483648）
    [255, 255, 255, 255, 255, 255],
    [0, 0, 0, 0, 0, 1],
    [0, 1, 0, 0, 0, 0],
  ];
  for (const bytes of cases) {
    const expected = Number(BigInt(`0x${Buffer.from(bytes).toString("hex")}`) % (GEO591_KEY_CAP + 1n));
    const got = randomGeo591CursorStart({ bytes: Buffer.from(bytes) });
    assert.equal(got, expected, `bytes=${bytes.join(",")}`);
    assert.ok(Number.isSafeInteger(got) && got >= 0 && got <= Number(GEO591_KEY_CAP));
  }
  // 直接對照「32 位元寫法會壞掉的樣子」：同一個值用 `| 0` 會變負數。
  assert.equal(2147483648 | 0, -2147483648, "測試前提：32 位元寫法真的會把 2^31 折成負數");
  assert.equal(randomGeo591CursorStart({ bytes: Buffer.from([0, 0, 128, 0, 0, 0]) }), 2 ** 31);
});

test("沒設種子時隨機起點落在鍵段內，而且真的會變", () => {
  const draws = Array.from({ length: 20 }, () => randomGeo591CursorStart());
  for (const value of draws) {
    assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= Number(GEO591_KEY_CAP), `起點 ${value} 必須落在 [0, ${GEO591_KEY_CAP}]`);
  }
  assert.ok(new Set(draws).size > 1, "20 次抽樣不應該永遠是同一個值");
});

test("nextGeo591Cursor：有列接在最後一列之後，沒有列歸零", () => {
  assert.equal(nextGeo591Cursor([]), 0);
  assert.equal(nextGeo591Cursor(null), 0);
  assert.equal(nextGeo591Cursor([{ post_id: 962003 }]), 962003);
  assert.equal(nextGeo591Cursor([{ post_id: 962003 }, { post_id: 2699975575 }]), 2699975575);
  assert.equal(nextGeo591Cursor([{ post_id: null }]), 0);
});

test("換起點不會漏列：不同起點跑完整循環，欠補列集合都被走遍（而且起點真的改變第一批）", () => {
  const firstBatches = new Map();
  for (const start of [0, 962013, 962050, 2699975575]) {
    const { seen } = runCycle(start);
    const unique = new Set(seen);
    assert.deepEqual(
      [...unique].sort((a, b) => a - b),
      [...NEEDY_IDS].sort((a, b) => a - b),
      `起點 ${start}：完整循環必須走遍所有欠補列（不多不缺）`,
    );
    for (const id of NOT_NEEDY_IDS) assert.ok(!unique.has(id), `起點 ${start}：已快取的列不該進工作清單`);
    firstBatches.set(start, seen[0]);
  }
  // 起點是 962013 時，第一批必須排在它之後（＝真的從那裡開始，不是每次都從 0）。
  assert.ok(firstBatches.get(962013) > 962013, "起點 962013 的第一批必須大於 962013");
  assert.ok(firstBatches.get(0) < firstBatches.get(962013), "不同起點應該看到不同的第一批");
  // 起點超過所有鍵值時第一段回 0 列 ⇒ 游標歸零，看到的第 1 列就是最小的欠補列。
  assert.equal(firstBatches.get(2699975575), Math.min(...NEEDY_IDS), "起點在鍵段尾之後：應該從 0 重新走一次");
});

test("接線：watcher 用 geo591CursorStart() 當起點、用 nextGeo591Cursor() 推進（不可以改回固定 0）", () => {
  const watcher = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  assert.match(watcher, /import \{ geo591CursorStart, nextGeo591Cursor \} from "\.\/geo591Cursor\.js";/);
  assert.match(watcher, /^let geo591ScanCursor = geo591CursorStart\(\);$/m);
  assert.ok(!/^let geo591ScanCursor = 0;$/m.test(watcher), "起點不可以退回固定 0");
  assert.match(watcher, /geo591ScanCursor = nextGeo591Cursor\(rows\);/);
  assert.match(watcher, /const rows = await needing591GeoAsync\(\{ limit: cap, cursor: geo591ScanCursor \}\);/);
});
