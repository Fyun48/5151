// Keep the complete candidate shape in one place. A literal object retains
// V8 fast properties; pg array mode avoids inserting wide-row keys one at a time.
export function candidateRowFromValues(values) {
  return {
    post_id: values[0],
    source: values[1],
    source_id: values[2],
    source_key: values[3],
    url: values[4],
    price: values[5],
    price_num: values[6],
    extra_fee: values[7],
    extra_fees: values[8],
    extra_fee_text: values[9],
    price_contain_text: values[10],
    title: values[11],
    address: values[12],
    address_norm: values[13],
    area_name: values[14],
    layout: values[15],
    floor_name: values[16],
    kind_name: values[17],
    tags: values[18],
    role_name: values[19],
    contact_name: values[20],
    contact_role: values[21],
    contact_uid: values[22],
    agency: values[23],
    lat: values[24],
    lng: values[25],
    geo_source: values[26],
    location_class: values[27],
    match_post_id: values[28],
    match_level: values[29],
    match_verdict: values[30],
    match_rejected: values[31],
    offline: values[32],
    offline_confirmed: values[33],
    hidden: values[34],
    hidden_at: values[35],
    last_event: values[36],
    first_seen_at: values[37],
    last_seen_at: values[38],
    refresh_time: values[39],
    listed_by_user_id: values[40],
    self_status: values[41],
    // 591 詳情帶回的絕對發佈時間（ISO 字串）。**一律加在清單尾端**：values 是位置對應，
    // 插在中間會讓下面每一個索引位移。排序（listingEffectiveUpdatedAt）與列表卡都要它。
    source_published_at: values[42],
  };
}

export const LIST_CANDIDATE_KEYS = Object.freeze(Object.keys(candidateRowFromValues([])));
export const LIST_CANDIDATE_COLUMNS = LIST_CANDIDATE_KEYS.join(", ");

// ── 會員列表的「共用窄列集合」（裁決 §4.1 P2／本包第 3 步）─────────────────────
//
// 這是 list 與 stats **共用**的候選載體定義：兩個路徑都靠 `listingSearchBuildContext()`
// 的 `candidateColumns` 取同一份列集合（`listingSearchPage.js` 先載一份給 stats，再把同一批
// 列交給 list 重用），所以「stats 不會自己再掃一次完整候選」是**由這份定義保證**的，
// 而不是靠兩邊各自記得寫一樣的 SQL。
//
// 為什麼**不是**更少的欄位：2026-10-11 逐欄查證的結果是 42 欄**全部**都有候選階段的讀取點
// （需求表見 `v3/test/list-candidate-carrier.test.js` 的 REQUIREMENT_TABLE），
// 因此本包不做欄位級瘦身 —— `listingSearchAsync.js:53-58` 記載的 astra 2026-09-25 §2.1
// 「窄欄位實驗已撤回、撤回條件是要先有完整 parity」正是同一個結論。
// 本包真正縮窄的是**候選集合本身**（行政區投影預篩），不是列寬。
// 2026-10-12：新增 source_published_at（591 詳情的絕對發佈日）⇒ 載體為 43 欄；讀取點是
// 排序用的 `listingEffectiveUpdatedAt`（db.js）與列表卡的「發佈」列，需求表同步更新。
export const MEMBER_LIST_REQUIRED_COLUMNS = Object.freeze([...LIST_CANDIDATE_KEYS]);
export const MEMBER_LIST_CANDIDATE_KEYS = MEMBER_LIST_REQUIRED_COLUMNS;
export const MEMBER_LIST_CANDIDATE_COLUMNS = MEMBER_LIST_CANDIDATE_KEYS.join(", ");

/** 給驗證器／測試用：回傳「被讀到但不在載體裡」的欄位（空陣列＝合法）。 */
export function missingMemberListColumns(columns) {
  const present = new Set(Array.isArray(columns) ? columns : String(columns || "").split(",").map((s) => s.trim()));
  return MEMBER_LIST_REQUIRED_COLUMNS.filter((column) => !present.has(column));
}

// PG 公開列表路徑的候選查詢欄位（searchPublicListingsAsync 用）。這是「過濾＋排序＋識別」
// 真正會讀到的欄位：其餘 6 欄（address_norm／layout／match_rejected／hidden_at／last_event／
// self_status）只在「頁面二次 SELECT *」與「非公開列表的成員/自我列表/配對」路徑才會讀到，
// 公開候選階段碰不到。頁面資料仍由 `post_id = ANY` 的 `SELECT *` 完整補回，語意不變。
// 每欄被哪一道過濾/排序/affiliate 判定讀到，見 v3/test/public-listings-candidate-columns.test.js
// 的欄位需求查證表。
// 2026-10-12：source_published_at 併入這一組——訪客的 `sort=newest` 由 Node 端的
// sortListingsSteps 讀 listingEffectiveUpdatedAt（發佈日是它的第二順位來源），只在頁面
// SELECT * 補回會讓「排序」看不到它（顯示看得到、順序卻是舊的 refresh_time 快照）。
export const PUBLIC_LISTING_CANDIDATE_COLUMNS = [
  "post_id", "source", "source_id", "source_key", "url", "price", "price_num",
  "extra_fee", "extra_fees", "extra_fee_text", "price_contain_text", "title",
  "address", "area_name", "floor_name", "kind_name", "tags", "role_name",
  "contact_name", "contact_role", "contact_uid", "agency", "lat", "lng",
  "geo_source", "location_class", "match_post_id", "match_level", "match_verdict",
  "offline", "offline_confirmed", "hidden", "first_seen_at", "last_seen_at",
  "refresh_time", "listed_by_user_id", "source_published_at",
].join(", ");

// Only for the canonical 42-column PG candidate projection, before decoration.
// Explicit fields avoid enumerating/copying a wide object for every personal view.
// Generic rows keep using overlayPersonal's spread so additional fields survive.
export function candidateRowWithPersonal(row, personal) {
  return {
    post_id: row.post_id,
    source: row.source,
    source_id: row.source_id,
    source_key: row.source_key,
    url: row.url,
    price: row.price,
    price_num: row.price_num,
    extra_fee: row.extra_fee,
    extra_fees: row.extra_fees,
    extra_fee_text: row.extra_fee_text,
    price_contain_text: row.price_contain_text,
    title: row.title,
    address: row.address,
    address_norm: row.address_norm,
    area_name: row.area_name,
    layout: row.layout,
    floor_name: row.floor_name,
    kind_name: row.kind_name,
    tags: row.tags,
    role_name: row.role_name,
    contact_name: row.contact_name,
    contact_role: row.contact_role,
    contact_uid: row.contact_uid,
    agency: row.agency,
    lat: row.lat,
    lng: row.lng,
    geo_source: row.geo_source,
    location_class: row.location_class,
    match_post_id: row.match_post_id,
    match_level: row.match_level,
    match_verdict: row.match_verdict,
    match_rejected: row.match_rejected,
    offline: row.offline,
    offline_confirmed: row.offline_confirmed,
    hidden: personal.hidden,
    hidden_at: personal.hidden_at,
    last_event: row.last_event,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    refresh_time: row.refresh_time,
    listed_by_user_id: row.listed_by_user_id,
    self_status: row.self_status,
    source_published_at: row.source_published_at,
    viewed: personal.viewed,
    watched: personal.watched,
    watch_note: personal.watch_note,
    viewed_at: personal.viewed_at,
    watched_at: personal.watched_at,
  };
}
