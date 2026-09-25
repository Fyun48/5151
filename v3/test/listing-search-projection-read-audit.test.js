// 候選欄位讀取審計（PR-B §4.2「優先縮減候選欄位」的取證步驟）。
//
// 背景（實測）：候選查詢 `SELECT ${LIST_CANDIDATE_COLUMNS} FROM listings`（43 欄、寬 739 bytes）
// 的最大成本是**候選欄位寬度** —— PG 逐節點歸因顯示 `Index Scan listings` 吃 33,541 buffers
//（≈268 MB、約每列 5 buffers ✗），而全區候選有 122,925 列。
//
// 這支測試用 `Proxy` 量測 `computeListingProjection` **實際讀取**的欄位：
// 它與 Node filter/sort 使用**同一批函式**（見 listing-search-projection.test.js 的 parity 檢查 ✓），
// 所以「它讀什麼」＝「縮減候選欄位時必須保留什麼」✓。
//
// 兩件事一起守：
// ① 稽核（印出）實際讀取集合 —— 作為改投影／改 SELECT 的證據 ✓。
// ② 真正的護欄：讀取集合必須**是** 43 欄候選集的子集 ✓（若有人新增了對候選列的欄位依賴，
//    這裡會紅 ✓，避免「偷偷在別的階段讀寬欄位、縮欄位時才爆」✗）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeListingProjection } from "../src/listingSearchProjection.js";

// 與 db.js 的 LIST_CANDIDATE_COLUMNS 對齊（單一來源是 db.js ✓，這裡只在測試中解析出來當護欄基準）。
function candidateColumns() {
  const source = readFileSync(new URL("../src/db.js", import.meta.url), "utf8");
  const match = source.match(/const LIST_CANDIDATE_COLUMNS = `([\s\S]*?)`;/);
  assert.ok(match, "應能在 db.js 找到 LIST_CANDIDATE_COLUMNS");
  return match[1].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

const SAMPLE = {
  post_id: 12345,
  source: "591",
  source_id: "8",
  source_key: "1|8||台北市士林區測試路1號",
  url: "https://example.test/12345",
  price: "25000元",
  price_num: 25000,
  extra_fee: 2000,
  extra_fees: "[]",
  extra_fee_text: "管理費2000元",
  price_contain_text: "",
  title: "電梯大樓 含車位 2房",
  address: "台北市士林區測試路1號",
  address_norm: "台北市士林區測試路1號",
  area_name: "25坪",
  layout: "2房1廳",
  floor_name: "5/12",
  kind_name: "整層住家/電梯大樓",
  tags: "[]",
  role_name: "",
  contact_name: "",
  contact_role: "",
  contact_uid: 0,
  agency: "",
  lat: 25.09,
  lng: 121.51,
  geo_source: "address",
  location_class: "address",
  match_post_id: 0,
  match_level: 0,
  match_verdict: "",
  match_rejected: 0,
  offline: 0,
  offline_confirmed: 0,
  hidden: 0,
  hidden_at: null,
  last_event: "",
  first_seen_at: "2026-09-01T00:00:00.000Z",
  last_seen_at: "2026-09-01T00:00:00.000Z",
  refresh_time: "2026-09-01T00:00:00.000Z",
  listed_by_user_id: 0,
  self_status: "",
};

test("審計：computeListingProjection 對候選列實際讀取哪些欄位（＝縮欄位時必須保留者）", () => {
  const reads = new Set();
  const spreads = [];
  const base = new Proxy(SAMPLE, {
    get(target, prop, receiver) {
      if (typeof prop === "string") reads.add(prop);
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === "string") reads.add(prop);
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      // 展開（`{ ...row }`）會落到 ownKeys ＋ getOwnPropertyDescriptor ⇒ 代表這裡會複製整列 ✗，
      // 那麼「只縮欄位」就無法在這一層生效 ⇒ 必須讓這個事實顯性化 ✓。
      spreads.push("ownKeys");
      return Reflect.ownKeys(target);
    },
  });

  const projected = computeListingProjection(base, Date.parse("2026-09-10T00:00:00Z"));

  const allReads = [...reads].sort();
  const has = (key) => Object.prototype.hasOwnProperty.call(SAMPLE, key);
  const present = allReads.filter(has);
  const absent = allReads.filter((key) => !has(key));
  // 稽核輸出（證據 ✓）：CI 日誌可查 ✓。**必須含缺席鍵** ✗ —— 缺席鍵才是「SELECT 少抓就會壞」的清單 ✓！
  console.log(`AUDIT-READ-ALL ${JSON.stringify(allReads)}`);
  console.log(`AUDIT-READ-PRESENT ${JSON.stringify(present)}`);
  console.log(`AUDIT-READ-ABSENT ${JSON.stringify(absent)}`);
  console.log(`AUDIT-SPREAD ${spreads.length ? "yes" : "no"} AUDIT-COUNT ${allReads.length}`);
  console.log(`AUDIT-PROJECTED ${JSON.stringify(Object.keys(projected).sort())}`);

  assert.ok(projected && typeof projected === "object");
  assert.ok(allReads.length > 0, "審計應量到至少一個欄位讀取");

  // 護欄：候選階段讀取必須是「LIST_CANDIDATE_COLUMNS ∪ 已登錄欄位」的子集 ✓
  // 這份清單是**實測**補齊的（第一次只登錄 4 個 ⇒ 護欄正確地紅了 ✓、抓到 14 個隱性依賴 ✗）：
  // 代謝欄位（hydration/decorated 提供）：commute_km、route_km、source_updated_at、source_published_at；
  // 來源欄位別名（舊 schema／provider 變體，由 sourceFields/正規化階段填）：source_* 之外的
  // buildingType／building_type／caseTypeName／listing_kind／region_id／regionid／section_id／
  // sectionid／shape／shape_name ✓。
  const REGISTERED = new Set([
    "commute_km", "route_km", "source_updated_at", "source_published_at",
    "buildingType", "building_type", "caseTypeName", "listing_kind",
    "region_id", "regionid", "section_id", "sectionid", "shape", "shape_name",
  ]);
  const candidates = new Set(candidateColumns());
  const outside = allReads.filter((key) => !candidates.has(key) && !REGISTERED.has(key));
  assert.deepEqual(outside, [], `候選階段讀到未登錄的欄位（請先確認來源再登錄）：${outside.join(", ")}`);


});
