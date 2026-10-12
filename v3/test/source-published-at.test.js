// 591 列表卡的「此房屋在…發佈」列（2026-10-12）。
//
// 資料流：591 詳情 API `data.favData.posttime`（epoch 秒）
//   → client591.sourcePublishedAtFromDetail()（fail-soft，回 ISO 字串或空字串）
//   → fetchListingDetail() 回傳物件 → watcher.applyFetchedDetail()
//   → setListingDetail → listings.source_published_at
//   → 候選載體（listingCandidateRow）→ 列表卡 formatListingPublished()。
//
// 這裡釘住三件事：
//   ① posttime → ISO 的解析（有值／缺值／壞值／不合理值）
//   ② 落地規則：新值非空才覆寫，空字串保留舊值（upsert 與詳情 UPDATE 都一樣）
//   ③ 前端文案：<24h 用小時（0 小時＝剛剛）、否則用 M月D日（非當年加年份）
// 外加兩條接線守門：PG 既有表要冪等補欄（寫入路徑 ＋ 讀路徑），否則查詢會以 42703 失敗。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sourcePublishedAtFromDetail } from "../src/client591.js";
import { ensureSourcePublishedAtOnce, sourcePublishedAtDdlStatements } from "../src/repository/writePath.js";
import { candidateRowFromValues, LIST_CANDIDATE_KEYS, LIST_CANDIDATE_COLUMNS } from "../src/listingCandidateRow.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href);

// 22094236 的真實回傳值（2026-10-12 實測）。
const SAMPLE_POSTTIME = 1790759972; // 2026-09-30T09:19:32Z

test("① posttime → ISO：有值／字串值／缺值／壞值都不 throw，壞值一律算缺資料", () => {
  assert.equal(sourcePublishedAtFromDetail({ favData: { posttime: SAMPLE_POSTTIME } }), "2026-09-30T09:19:32.000Z");
  assert.equal(sourcePublishedAtFromDetail({ favData: { posttime: String(SAMPLE_POSTTIME) } }), "2026-09-30T09:19:32.000Z");
  // 缺資料（沒有 favData／沒有 posttime／空字串／null）⇒ 空字串，不是 throw
  assert.equal(sourcePublishedAtFromDetail({}), "");
  assert.equal(sourcePublishedAtFromDetail({ favData: {} }), "");
  assert.equal(sourcePublishedAtFromDetail({ favData: { posttime: "" } }), "");
  assert.equal(sourcePublishedAtFromDetail({ favData: { posttime: null } }), "");
  assert.equal(sourcePublishedAtFromDetail(), "");
  // 壞值 ⇒ 空字串（負數、0、NaN、字串、超出合理範圍的秒數）
  for (const bad of [-1, 0, Number.NaN, "not-a-timestamp", {}, [], 99999999999999, 1]) {
    assert.equal(sourcePublishedAtFromDetail({ favData: { posttime: bad } }), "", `bad posttime ${String(bad)}`);
  }
  // 解析元件壞掉也不得往外丟（fail-soft 的硬性要求）
  assert.doesNotThrow(() => sourcePublishedAtFromDetail({ get favData() { throw new Error("boom"); } }));
  assert.equal(sourcePublishedAtFromDetail({ get favData() { throw new Error("boom"); } }), "");
});

test("① 解析器有接進 fetchListingDetail 的回傳物件（正則守門，避免只加函式沒接線）", () => {
  const src = readFileSync(path.join(dir, "../src/client591.js"), "utf8");
  assert.match(src, /source_published_at: sourcePublishedAtFromDetail\(body\.data\)/);
});

test("① 詳情 → DB 的鏈有接上：applyFetchedDetail 要把發佈日交給 setListingDetail", () => {
  // 2026-10-12 實測踩到的坑：解析器有了、SQL 有了，但 applyFetchedDetail 沒有把
  // detail.source_published_at 放進 input ⇒ 沙盒跑完 source_published_at 全部是空的。
  const watcher = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  const start = watcher.indexOf("async function applyFetchedDetail");
  assert.ok(start > 0, "找不到 applyFetchedDetail");
  const body = watcher.slice(start, watcher.indexOf("function listingHasTrustedPin", start));
  assert.match(body, /source_published_at:\s*detail\.source_published_at/);
});

test("② source_published_at 落地：非空才覆寫，空字串保留舊值（upsert ＋ 詳情 UPDATE）", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-src-published-"));
  const script = `
    import { db, upsertListing, setListingDetail, listingEffectiveUpdatedAt } from ${dbUrl};
    import { candidateRowFromValues, LIST_CANDIDATE_KEYS, LIST_CANDIDATE_COLUMNS } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/listingCandidateRow.js")).href)};
    const stamp = "2026-10-12T00:00:00.000Z";
    const ISO = "2026-09-30T09:19:32.000Z";
    const base = (post_id) => ({ post_id, source: "591", source_key: "1|8|||", search_key: "https://example.test",
      title: "t" + post_id, url: "https://rent.591.com.tw/" + post_id, price: "20000元", price_num: 20000, extra_fees: [],
      address: "台中市西屯區測試路1號", area_name: "20坪", layout: "2房1廳", floor_name: "5/12",
      kind_name: "整層住家", role_name: "", cover: "", tags: "[]", refresh_time: "", first_seen_at: stamp,
      last_seen_at: stamp, last_event: "new" });
    const read = (id) => db.prepare("SELECT source_published_at FROM listings WHERE post_id=?").get(id)?.source_published_at ?? null;

    // 1) 詳情補抓（帶發佈日）落值
    upsertListing(base(910001));
    setListingDetail(910001, { source_published_at: ISO, fetched: 0 });
    const afterDetail = read(910001);
    // 2) 詳情補抓沒帶發佈日（空字串）⇒ 保留舊值
    setListingDetail(910001, { source_published_at: "", fetched: 0 });
    const afterEmptyDetail = read(910001);
    // 3) 列表 upsert（591 列表 API 沒有發佈日 ⇒ 每次都是空字串）⇒ 仍然保留舊值
    upsertListing({ ...base(910001), source_published_at: "" });
    const afterEmptyUpsert = read(910001);
    // 4) 列表 upsert 帶新值（補抓流程把詳情結果交給 upsert 時）⇒ 覆寫
    upsertListing({ ...base(910001), source_published_at: "2026-01-02T03:04:05.000Z" });
    const afterNewUpsert = read(910001);
    // 5) 全新的一列（從沒補抓過）⇒ 空字串
    upsertListing(base(910002));
    const fresh = read(910002);

    // 6) 讀取端：候選載體尾端欄位 ↔ 位置索引對得上，且排序鍵改用發佈日
    const raw = db.prepare(\`SELECT \${LIST_CANDIDATE_COLUMNS} FROM listings WHERE post_id=?\`).get(910001);
    const candidate = candidateRowFromValues(LIST_CANDIDATE_KEYS.map((key) => raw[key]));
    const sortKey = listingEffectiveUpdatedAt({ ...candidate, first_seen_at: "2020-01-01T00:00:00.000Z", refresh_time: "3小時前" });
    console.log(JSON.stringify({ afterDetail, afterEmptyDetail, afterEmptyUpsert, afterNewUpsert, fresh,
      candidateValue: candidate.source_published_at, tailKey: LIST_CANDIDATE_KEYS[LIST_CANDIDATE_KEYS.length - 1],
      candidateCount: LIST_CANDIDATE_KEYS.length, sortKeyIso: new Date(sortKey).toISOString() }));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const out = JSON.parse(result.stdout.trim().split("\n").filter((r) => r.startsWith("{")).at(-1));
    assert.equal(out.afterDetail, "2026-09-30T09:19:32.000Z", "詳情帶發佈日要落地");
    assert.equal(out.afterEmptyDetail, "2026-09-30T09:19:32.000Z", "詳情空字串不得清掉舊值");
    assert.equal(out.afterEmptyUpsert, "2026-09-30T09:19:32.000Z", "列表 upsert 空字串不得清掉舊值");
    assert.equal(out.afterNewUpsert, "2026-01-02T03:04:05.000Z", "非空新值要覆寫");
    assert.equal(out.fresh, "", "沒補抓過的列是空字串（不是 NULL）");
    assert.equal(out.tailKey, "source_published_at", "新欄必須加在候選載體尾端（位置索引不得位移）");
    assert.equal(out.candidateCount, 43, "候選載體 43 欄（原 42 ＋ source_published_at）");
    assert.equal(out.candidateValue, "2026-01-02T03:04:05.000Z", "SELECT 欄清單 ↔ values 索引要對得上");
    assert.equal(out.sortKeyIso, "2026-01-02T03:04:05.000Z", "排序鍵（listingEffectiveUpdatedAt）改用發佈日");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("③ 前端文案：由絕對時間戳現算（<24h 小時、0 小時剛剛、否則 M月D日／非當年加年份）", () => {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  const start = html.indexOf("function formatListingPublished");
  const end = html.indexOf("function esc(");
  assert.ok(start > 0 && end > start, "找不到 formatListingPublished");
  const now = Date.parse("2026-10-12T12:00:00+08:00");
  const fakeDate = class extends Date {
    constructor(...args) { if (args.length === 0) super(now); else super(...args); }
    static now() { return now; }
  };
  const is591 = (item) => String(item?.source ?? "591") === "591" || item?.source === "";
  const fn = new Function("is591Source", "Date", `${html.slice(start, end)}\nreturn formatListingPublished;`)(is591, fakeDate);

  const at = (iso) => ({ source: "591", source_published_at: iso });
  assert.equal(fn(at("2026-10-12T11:30:00+08:00")), "此房屋剛剛發佈", "0 小時＝剛剛發佈");
  assert.equal(fn(at("2026-10-12T09:30:00+08:00")), "此房屋在2小時前發佈", "floor 小時數");
  assert.equal(fn(at("2026-10-12T02:00:00+08:00")), "此房屋在10小時前發佈");
  assert.equal(fn(at("2026-09-30T18:00:00+08:00")), "此房屋在9月30日發佈", "同年＝M月D日");
  assert.equal(fn(at("2025-09-30T18:00:00+08:00")), "此房屋在2025年9月30日發佈", "非當年加 YYYY年 前綴");
  // 邊界：剛好 24 小時前走日期格式；未來時間（站方時鐘偏移）當「剛剛」，不得出現負數小時
  assert.equal(fn(at("2026-10-11T12:00:00+08:00")), "此房屋在10月11日發佈");
  assert.equal(fn(at("2026-10-12T13:00:00+08:00")), "此房屋剛剛發佈");
  // 非 591 或解析不了 ⇒ 不顯示
  assert.equal(fn({ source: "5168", source_published_at: "2026-09-30T18:00:00+08:00" }), "");
  assert.equal(fn({ source: "591", source_published_at: "" }), "");
  assert.equal(fn({ source: "591", source_published_at: "not-a-date" }), "");
  assert.equal(fn({ source: "591" }), "");
  assert.equal(fn({}), "");

  // 卡片：發佈列必須在「更新」列**上方**，且沿用 .when／.when-label（label 用「發佈」）
  const card = html.slice(html.indexOf('class="item-title"'), html.indexOf('class="item-details"'));
  const publishedIdx = card.indexOf("formatListingPublished(item)");
  const whenIdx = card.indexOf("formatListingWhen(item)");
  assert.ok(publishedIdx > 0 && whenIdx > publishedIdx, "發佈列要在更新列上方");
  assert.match(card, /class="when"><span class="when-label">發佈<\/span>\$\{esc\(formatListingPublished\(item\)\)\}/);
});

test("④ 既有 PG 表要冪等補欄，而且讀路徑也要補（否則候選／peer SELECT 會 42703）", async () => {
  // DDL 內容與冪等：同一條 ALTER 只發一次（WeakSet 記在 driver 上）。
  const ddl = sourcePublishedAtDdlStatements();
  assert.deepEqual(ddl, ["ALTER TABLE listings ADD COLUMN IF NOT EXISTS source_published_at text"]);
  const statements = [];
  const fakeDriver = { exec: async (sql) => { statements.push(sql); } };
  await ensureSourcePublishedAtOnce(fakeDriver);
  await ensureSourcePublishedAtOnce(fakeDriver);
  assert.deepEqual(statements, ddl, "同一行程只補一次欄（冪等）");
  await ensureSourcePublishedAtOnce(null); // 沒有 driver 也不得 throw

  // 接線：寫入端與讀路徑都要呼叫（沙盒實測：只靠寫入端補，掃描先跑就整批失敗）。
  const writePath = readFileSync(path.join(dir, "../src/repository/writePath.js"), "utf8");
  assert.match(writePath, /export async function ensureSourcePublishedAtOnce/);
  const db = readFileSync(path.join(dir, "../src/db.js"), "utf8");
  assert.match(db, /export async function ensureSourcePublishedAtSchema\(\)/);
  const contextStart = db.indexOf("export async function buildListRequestContextFromPg");
  const contextBody = db.slice(contextStart, contextStart + 2000);
  assert.match(contextBody, /await ensureSourcePublishedAtSchema\(\);/, "讀路徑（請求 context）要補欄");
  assert.match(db.slice(db.indexOf("export async function persistListing")), /await ensureSourcePublishedAtOnce\(pool\)/);
  const crawlerWrites = readFileSync(path.join(dir, "../src/crawlerWrites.js"), "utf8");
  assert.match(crawlerWrites, /await ensureSourcePublishedAtOnce\(options\.pgDriver \|\| \(await sharedPgDriver\(\)\)\)/);
  const watcher = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  assert.ok(watcher.indexOf("await ensureSourcePublishedAtSchema();") < watcher.indexOf('setCrawlPhase("下架掃描")'),
    "補欄要在下架掃描之前");
});
