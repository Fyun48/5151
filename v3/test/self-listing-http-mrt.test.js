// R2（第二輪複審）：從**真實 HTTP 建立／發布入口**一路驗到持久化與配對。
//
// 審閱指出：先前的 R2 驗收只用手寫 snapshot，沒有覆蓋「會員自己帶 mrt_walk_m／mrt_source
// 進來也會被接受」與「已查證不符合（none）在發布後掉回 unknown」這兩條真實路徑。
//
// 這一支把三個外部依賴都換成可控輸入，但**走真的 HTTP 路由與真的寫入**：
//   1. 地理編碼：先把座標塞進 `geo_cache`（key = `addressVersion(address)`），快取命中不連外。
//   2. 步行路線：`MRT_FOOT_ROUTE_BASE` 指向本檔啟動的 stub 服務（可控制距離）。
//   3. 登入：走真的 `/api/captcha` ＋ `/api/login`（驗證碼的文字節點可解析）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(dir, "../..");
const ADDRESS = "台北市士林區中正路100號";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function waitForHealth(base, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch { /* 還沒起來 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("伺服器沒有在時限內起來");
}

/** 驗證碼的文字節點就是答案（`<text …>A</text>`），照 `/api/login` 的契約送。 */
async function login(base) {
  const cap = await fetch(`${base}/api/captcha`).then((r) => r.json());
  const answer = [...String(cap.svg || "").matchAll(/>([0-9A-Za-z])<\/text>/g)].map((m) => m[1]).join("");
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo@example.com", password: "demopass123", captchaId: cap.id, captchaAnswer: answer }),
  });
  const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((c) => c.split(";")[0]).join("; ");
  assert.ok(res.ok, `登入失敗：${await res.text()}`);
  return cookie;
}

test("R2：HTTP 建立入口——偽造查證欄位無效、within／outside 都要正確落地並影響配對", { timeout: 180_000 }, async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-selflisting-http-"));
  // 1) stub 步行路線服務（距離由測試控制）
  let stubDistance = 620;
  let stubBroken = false;
  const stub = createServer((req, res) => {
    if (!req.url.includes("/route/v1/foot/")) { res.statusCode = 404; res.end(); return; }
    if (stubBroken) { res.statusCode = 503; res.end("upstream unavailable"); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ code: "Ok", routes: [{ distance: stubDistance, duration: 100 }] }));
  });
  const stubPort = await listen(stub);
  t.after(() => { try { stub.close(); } catch { /* 已關 */ } });

  // 2) 啟動真的伺服器（先佔一個號碼、**關掉**再讓給 app，否則 app 綁不上同一個埠）
  const placeholder = createServer();
  const appPort = await listen(placeholder);
  await new Promise((resolve) => placeholder.close(resolve));
  const child = spawn(process.execPath, ["v3/src/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(appPort),
      HOST: "127.0.0.1",
      DB_DRIVER: "sqlite",
      AUTH_EMAIL: "demo@example.com",
      AUTH_PASSWORD: "demopass123",
      MRT_FOOT_ROUTE_BASE: `http://127.0.0.1:${stubPort}/routed-foot/route/v1/foot`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => { logs += String(d); });
  child.stderr.on("data", (d) => { logs += String(d); });
  t.after(() => {
    try { child.kill("SIGKILL"); } catch { /* 已結束 */ }
    rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${appPort}`;
  try {
    await waitForHealth(base);
  } catch (error) {
    throw new Error(`${error.message}\n--- server log ---\n${logs.slice(-2000)}`);
  }
  const cookie = await login(base);

  // 3) 讓帳號「註冊滿 24 小時」＋把地址的座標先塞進 geo_cache（離線定位）
  const { addressVersion } = await import("../src/geoQueue.js");
  const dbPath = path.join(dataDir, "v3.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  db.prepare("UPDATE users SET created_at = ? WHERE email = ?").run("2026-01-01T00:00:00.000Z", "demo@example.com");
  const geoKey = addressVersion(ADDRESS);
  // ⚠️ 座標要**離捷運站 1 公里內**（candidates 是先用直線距離篩的）：這裡用士林站附近，
  //    否則一個候選站都沒有，狀態會直接是 outside（已查證沒有），測不到 within。
  db.prepare(
    `INSERT OR REPLACE INTO geo_cache(address, lat, lng, quality, geo_source, location_class, city, district, updated_at)
     VALUES (?, 25.0930, 121.5240, 'house', 'test', 'house', '台北市', '士林區', '2026-10-01T00:00:00.000Z')`,
  ).run(geoKey);

  const create = async (extra = {}) => {
    const res = await fetch(`${base}/api/self-listings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        district: "1-8", rent: 32000, ping: 28.5, kind: "whole", role: "owner", floor: 5, total_floors: 12,
        rooms: 3, living: 2, bath: 2, contact_name: "林先生",
        street: ADDRESS, phone: "0912345678", accept_pledge: true,
        title: `HTTP 查證測試 ${Math.random().toString(36).slice(2, 8)}`,
        body: "這間房子我們住了六年，採光好、巷子安靜，走路三分鐘有傳統市場。",
        ...extra,
      }),
    });
    const data = await res.json();
    assert.ok(res.ok, `建立失敗：${JSON.stringify(data)}`);
    return data;
  };
  const rowOf = (postId) => db.prepare("SELECT * FROM listings WHERE post_id = ?").get(Number(postId));

  // 4) 已查證「符合」：620 公尺 ⇒ state=within，而且**偽造的欄位必須被忽略**
  stubDistance = 620;
  const within = await create({
    // 會員自己想辦法：假造一個「符合」的查證結果（契約字串是公開的，只驗字串不足以防偽造）
    lat: 0, lng: 0, geo_source: "forged",
    mrt_state: "within", mrt_walk_m: 0, mrt_source: "osrm-foot:v1",
    mrt_station: "偽造站", mrt_checked_at: "2020-01-01T00:00:00.000Z",
  });
  const withinRow = rowOf(within.post_id);
  assert.equal(withinRow.self_mrt_state, "within");
  assert.equal(withinRow.self_mrt_nearest_m, 620, "要用站方查到的距離，不是會員帶的 0");
  assert.notEqual(withinRow.self_mrt_station, "偽造站", "站名要來自站方查證");
  assert.equal(withinRow.geo_source, "self", "座標來源要由站方寫入");

  // 5) 已查證「不符合」：1,049 公尺 ⇒ state=outside（不是掉回 unknown）
  stubDistance = 1049;
  const outside = await create({});
  const outsideRow = rowOf(outside.post_id);
  assert.equal(outsideRow.self_mrt_state, "outside", "路線超過 1 公里要存成 outside");
  assert.equal(outsideRow.self_mrt_nearest_m, 1049, "原始公尺要保留（不可四捨五入）");
  assert.equal(outsideRow.self_mrt_walk_m, null, "outside 沒有「符合的距離」");

  // 6) 配對：within 符合、outside 硬衝突
  const { listingMatchSnapshot, wishMatchSnapshot, evaluateMatch } = await import("../src/rentalMatch.js");
  db.prepare("INSERT OR IGNORE INTO users(id, email, created_at) VALUES (109,'http-renter@example.com','2026-01-01T00:00:00.000Z')").run();
  const wishRes = await fetch(`${base}/api/wish-rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ districts: ["1-8"], rent_max: 40000, housing_type: "any", body: "想要近捷運的房子。", mrt_walk: true, choices: {} }),
  });
  void wishRes; // 已有公開許願房時會回 409，直接讀既有的那一則
  const wishRow = db.prepare("SELECT * FROM demand_posts WHERE mrt_walk = 1 ORDER BY id DESC LIMIT 1").get();
  assert.ok(wishRow, "要有一則勾了捷運需求的許願房");
  const wish = wishMatchSnapshot(wishRow);
  assert.equal(wish.mrt_walk, true);

  const withinMatch = evaluateMatch(listingMatchSnapshot(withinRow), wish);
  assert.ok(withinMatch.matched_conditions.includes("mrt_walk"), `within 要符合：${JSON.stringify(withinMatch.explanation)}`);
  const outsideMatch = evaluateMatch(listingMatchSnapshot(outsideRow), wish);
  assert.equal(outsideMatch.eligible, false, "outside 要是硬衝突");
  assert.ok(outsideMatch.hard_conflicts.some((row) => row.code === "mrt_walk"), "硬衝突碼要是 mrt_walk");

  // 7) 路線服務失敗 ⇒ 維持未知（缺值不可以變成 0 公尺 ⇒ 符合）。
  //    這一筆**同時**帶偽造欄位：`{...body, ...geo}` 在 geo 是空物件時會讓偽造值活下來，
  //    所以一定要在「查證失敗」的情況下也驗一次。
  stubBroken = true;
  const unknown = await create({
    lat: 25.0, lng: 121.0, geo_source: "forged",
    mrt_state: "within", mrt_walk_m: 0, mrt_station: "偽造站", mrt_source: "osrm-foot:v1",
    mrt_checked_at: "2020-01-01T00:00:00.000Z",
  });
  const unknownRow = rowOf(unknown.post_id);
  assert.equal(unknownRow.self_mrt_state, null, "查不到就不可以寫狀態（偽造的 within 要失效）");
  assert.equal(unknownRow.self_mrt_walk_m, null, "缺值不可以變成 0");
  assert.equal(unknownRow.self_mrt_nearest_m, null);
  assert.notEqual(unknownRow.self_mrt_station, "偽造站", "偽造的站名不可以進資料庫");
  assert.equal(unknownRow.geo_source, "self", "座標來源只能由站方寫入（不是偽造的 forged）");
  const unknownMatch = evaluateMatch(listingMatchSnapshot(unknownRow), wish);
  assert.ok(unknownMatch.unmet_unknowns.includes("mrt_walk"), "沒有查證結果 ⇒ 未確認");
  assert.equal(unknownMatch.eligible, true, "未確認不可以變成硬衝突、也不可以變成符合");
  assert.ok(!unknownMatch.matched_conditions.includes("mrt_walk"), "未確認絕對不可以算符合");

  // 8) 同地址重新發布（複製成草稿 → 發布）時，服務仍然失敗 ⇒ 維持未知
  stubBroken = false;
  stubDistance = 1049;
  const copyRes = await fetch(`${base}/api/self-listings/${unknown.post_id}/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({}),
  });
  const copy = await copyRes.json();
  assert.ok(copyRes.ok, `複製草稿失敗：${JSON.stringify(copy)}`);
  // 複製的回應形狀是 `{ listing, form, original_id, unpublished: true }`（草稿在 `listing`）。
  const draftId = Number(copy?.listing?.post_id || copy?.post_id || copy?.id || 0);
  assert.ok(draftId, `要有草稿 id（實際 ${JSON.stringify(copy).slice(0, 200)}）`);
  // 草稿階段先確認它是未知，再用「同一個地址」發布一次（服務正常）⇒ 這次才會變成 outside
  const draftRow = rowOf(draftId);
  assert.equal(draftRow.self_mrt_state, null, "複製出來的草稿一開始是未知");
  stubBroken = true;
  const republish = await fetch(`${base}/api/self-listings/${draftId}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      district: "1-8", rent: 32000, ping: 28.5, kind: "whole", role: "owner", floor: 5, total_floors: 12,
      rooms: 3, living: 2, bath: 2, contact_name: "林先生", street: ADDRESS, phone: "0912345678",
      accept_pledge: true, title: "HTTP 查證測試（重發）",
      body: "這間房子我們住了六年，採光好、巷子安靜，走路三分鐘有傳統市場。",
    }),
  });
  assert.ok(republish.ok, `重新發布失敗：${await republish.text()}`);
  const republished = rowOf(draftId);
  assert.equal(republished.self_mrt_state, null, "服務失敗時同地址重發仍然維持未知");
  assert.equal(republished.self_mrt_walk_m, null, "缺值不可以變成 0 公尺");

  // 8b) 沿用舊結果時要驗契約：把來源改成「上一個版本」再同地址重發 ⇒ 不可以沿用
  db.prepare("UPDATE listings SET self_mrt_source = 'osrm-foot:v0' WHERE post_id = ?").run(draftId);
  const copy3Res = await fetch(`${base}/api/self-listings/${draftId}/copy`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({}),
  });
  const copy3 = await copy3Res.json();
  assert.ok(copy3Res.ok, `第三次複製失敗：${JSON.stringify(copy3)}`);
  const staleDraftId = Number(copy3?.listing?.post_id || 0);
  assert.ok(staleDraftId, "要有第三個草稿 id");
  // 草稿繼承了舊契約的 state ⇒ 同地址、服務又失敗時，**不可以**把它當成有效結果沿用
  db.prepare("UPDATE listings SET self_mrt_state = 'within', self_mrt_walk_m = 620, self_mrt_source = 'osrm-foot:v0' WHERE post_id = ?")
    .run(staleDraftId);
  stubBroken = true;
  const staleRes = await fetch(`${base}/api/self-listings/${staleDraftId}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      district: "1-8", rent: 32000, ping: 28.5, kind: "whole", role: "owner", floor: 5, total_floors: 12,
      rooms: 3, living: 2, bath: 2, contact_name: "林先生", street: ADDRESS, phone: "0912345678",
      accept_pledge: true, title: "HTTP 查證測試（舊契約）",
      body: "這間房子我們住了六年，採光好、巷子安靜，走路三分鐘有傳統市場。",
    }),
  });
  assert.ok(staleRes.ok, `舊契約重發失敗：${await staleRes.text()}`);
  const staleRow = rowOf(staleDraftId);
  assert.equal(staleRow.self_mrt_state, null, "舊契約（osrm-foot:v0）的查證結果不可以被沿用");
  assert.equal(staleRow.self_mrt_walk_m, null, "舊契約的距離也不可以留著");

  // 9) 改地址 ⇒ 舊的查證狀態必須失效
  stubBroken = false;
  stubDistance = 620;
  const movedAddress = "台北市士林區中正路200號";
  db.prepare(
    `INSERT OR REPLACE INTO geo_cache(address, lat, lng, quality, geo_source, location_class, city, district, updated_at)
     VALUES (?, 25.0930, 121.5240, 'house', 'test', 'house', '台北市', '士林區', '2026-10-01T00:00:00.000Z')`,
  ).run(addressVersion(movedAddress));
  // 再複製一份草稿來改地址（`open` 的刊登不能再 publish，一定要走草稿）。
  const copy2Res = await fetch(`${base}/api/self-listings/${draftId}/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({}),
  });
  const copy2 = await copy2Res.json();
  assert.ok(copy2Res.ok, `第二次複製失敗：${JSON.stringify(copy2)}`);
  const movedDraftId = Number(copy2?.listing?.post_id || 0);
  assert.ok(movedDraftId, "要有第二個草稿 id");
  const moveRes = await fetch(`${base}/api/self-listings/${movedDraftId}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      district: "1-8", rent: 32000, ping: 28.5, kind: "whole", role: "owner", floor: 5, total_floors: 12,
      rooms: 3, living: 2, bath: 2, contact_name: "林先生", street: movedAddress, phone: "0912345678",
      accept_pledge: true, title: "HTTP 查證測試（搬家）",
      body: "這間房子我們住了六年，採光好、巷子安靜，走路三分鐘有傳統市場。",
    }),
  });
  assert.ok(moveRes.ok, `改地址發布失敗：${await moveRes.text()}`);
  const movedRow = rowOf(movedDraftId);
  assert.equal(movedRow.self_mrt_state, "within", "新地址要重新查證");
  assert.equal(movedRow.self_mrt_nearest_m, 620);
  assert.equal(movedRow.lat !== null && movedRow.lat !== undefined, true, "新地址要有座標");
  db.close();
});
