// Decoration provider parity (child process).
//
// Decorates the same rows twice - once through the SQLite pipeline (listListings, which uses
// the default sqliteDecorationProvider) and once through a provider built from data preloaded
// with repository/decorationData.js (the path the PostgreSQL hot path now uses) - and asserts
// the cards are identical. Together with decoration-data.test.js (which proves the loaders
// return the same values on SQLite and PostgreSQL) this closes the equivalence chain.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcUrl = (name) => pathToFileURL(path.join(dir, "../src", name)).href;

const {
  db,
  decorateRowsWithProvider,
  defaultUserId,
  getSettings,
  listListings,
  mergeSameHouseForUser,
  preloadDecorationProviderAsync,
  saveCrawlSources,
  setCachedMrt,
  setCachedRoute,
  upsertListing,
  upsertRouteJob,
} = await import(srcUrl("db.js"));

saveCrawlSources({ items: [{ id: "houseprice", enabled: true }, { id: "591", enabled: true }] });
const uid = defaultUserId();
const stamp = "2026-09-21T00:00:00.000Z";
const geo = { lat: 25.1105, lng: 121.529, geo_source: "591" };
const base = {
  search_key: "https://example.test",
  cover: "",
  tags: "[]",
  role_name: "屋主",
  refresh_time: stamp,
  first_seen_at: stamp,
  last_seen_at: stamp,
  last_event: "new",
};
const rows = [
  {
    ...base, ...geo, post_id: 591301, source: "591", source_id: "1", source_key: "g-parity",
    url: "https://rent.591.com.tw/1", title: "同屋源主卡", price: "24000", price_num: 24000,
    extra_fees: [], address: "台北市士林區天玉街9巷3號", area_name: "19坪", layout: "1房1廳1衛",
    floor_name: "4/4", kind_name: "整層住家",
  },
  {
    ...base, ...geo, post_id: 591302, source: "591", source_id: "2", source_key: "g-parity",
    url: "https://rent.591.com.tw/2", title: "同屋源副卡", price: "26000", price_num: 26000,
    extra_fees: [], address: "台北市士林區天玉街9巷5號", area_name: "20坪", layout: "2房1廳1衛",
    floor_name: "5/5", kind_name: "整層住家",
  },
  {
    ...base, ...geo, post_id: 591303, source: "591", source_id: "3", source_key: "g-parity-solo",
    url: "https://rent.591.com.tw/3",
    title: "獨立卡", price: "30000", price_num: 30000, extra_fees: [],
    address: "台北市士林區中山北路七段1號", area_name: "30坪", layout: "3房2廳2衛",
    floor_name: "2/5", kind_name: "整層住家",
  },
];
for (const row of rows) upsertListing(row);

db.prepare(
  `INSERT OR REPLACE INTO user_listing_flags(user_id, post_id, viewed, watched, hidden, watch_note, viewed_at, watched_at, hidden_at)
   VALUES (?,?,?,?,?,?,?,?,?)`,
).run(uid, 591301, 1, 0, 0, "重點看過", stamp, null, null);
mergeSameHouseForUser(uid, [591301, 591303]);

const saved = getSettings(uid);
setCachedRoute(geo.lat, geo.lng, saved.workLat, saved.workLng, [4.2, 5.1], { am: 12, pm: 15 }, saved.commuteMode, "to_work");
setCachedRoute(saved.workLat, saved.workLng, geo.lat, geo.lng, [4.4], { am: 13, pm: 16 }, saved.commuteMode, "from_work");
setCachedMrt(geo.lat, geo.lng, { station: "芝山", walk_km: 0.4, walk_min: 6, ride_km: 2.1, ride_min: 9 });
upsertRouteJob({
  post_id: 591303, direction: "to_work", kind: "distance", commuteMode: saved.commuteMode,
  workLat: saved.workLat, workLng: saved.workLng, job_state: "failed",
});

const settings = {
  ...saved,
  searchUrls: [],
  watchDistricts: ["1-8"],
  commuteKm: 10,
  wholeFloorOnly: false,
  excludeLowFloors: false,
  excludeRooftop: false,
};
const args = { userId: uid, settings, filter: "all", sort: "newest", limit: 50 };

// A: the SQLite pipeline (default sqliteDecorationProvider).
const pipeline = listListings(args);
// 591303 was personally merged into 591301, so it must NOT be its own card - it travels in
// 591301's same_house bundle (which exercises the peers/extras preload too).
assert.equal(
  pipeline.listings.length,
  2,
  JSON.stringify(pipeline.listings.map((r) => r.post_id)),
);
const ids = pipeline.listings.map((row) => Number(row.post_id)).sort((a, b) => a - b);

// B: the same rows decorated through the production preload + provider path.
const exec = async (sql, params = []) => db.prepare(sql).all(...(params || []));
const rawRows = db
  .prepare(`SELECT * FROM listings WHERE post_id IN (${ids.map(() => "?").join(",")})`)
  .all(...ids);
const provider = await preloadDecorationProviderAsync({
  exec,
  rows: rawRows,
  settings,
  userId: uid,
  driver: "sqlite",
});
const decorated = decorateRowsWithProvider(rawRows, { settings, userId: uid, provider });

const pick = (list) => list
  .map((row) => ({
    post_id: Number(row.post_id),
    viewed: Number(row.viewed) || 0,
    watched: Number(row.watched) || 0,
    hidden: Number(row.hidden) || 0,
    watch_note: String(row.watch_note || ""),
    source_label: String(row.source_label || ""),
    commute_km: row.commute_km,
    commute_state: String(row.commute_state || ""),
    route_min_m: row.route_min_m ?? null,
    mrt_station: row.mrt_station ?? null,
    prep_status: row.prep_status ?? null,
    display_ready: row.display_ready ?? null,
    same_house_status: row.same_house?.status ?? null,
    same_house_peers: (row.same_house?.peers || []).map((peer) => Number(peer.post_id)).sort((a, b) => a - b),
  }))
  .sort((a, b) => a.post_id - b.post_id);

const viaPipeline = pick(pipeline.listings);
const viaProvider = pick(decorated);
if (JSON.stringify(viaPipeline) !== JSON.stringify(viaProvider)) {
  console.error("pipeline:", JSON.stringify(viaPipeline, null, 2));
  console.error("provider:", JSON.stringify(viaProvider, null, 2));
}
assert.deepEqual(viaProvider, viaPipeline, "preloaded provider must decorate identically to the SQLite pipeline");
console.log("decoration parity ok:", JSON.stringify({ ids, cards: viaProvider.length }));
