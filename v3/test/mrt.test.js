import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateMrtAccess,
  estimateMrtAccessForPoint,
  fetchMrtAccess,
  formatMrtAccess,
  isWalkableMrtDistance,
  makeMrtKey,
  nearbyWalkMrtStations,
  nearestMrtStation,
} from "../src/mrt.js";
import { MRT_STATIONS } from "../src/mrtStations.js";

test("MRT station list has unique names and valid coordinates", () => {
  const names = new Set();
  assert.ok(MRT_STATIONS.length > 80);
  for (const [name, lat, lng] of MRT_STATIONS) {
    assert.equal(names.has(name), false, name);
    names.add(name);
    assert.ok(lat > 24.8 && lat < 25.3, name);
    assert.ok(lng > 121.3 && lng < 121.7, name);
  }
});

test("nearest station for Nangang exhibition area is 南港展覽館", () => {
  const row = nearestMrtStation(25.05781, 121.6184);
  assert.equal(row.name, "南港展覽館");
  assert.ok(row.straightKm < 0.5);
});

test("nearest station for Shilin Dexing is 芝山 or 士林", () => {
  const row = nearestMrtStation(25.10628, 121.52419);
  assert.ok(["芝山", "士林", "明德"].includes(row.name), row.name);
});

test("estimated walk is a bit longer than the straight line", () => {
  const est = estimateMrtAccess(0.5);
  assert.equal(est.walk_km, 0.6);
  assert.equal(est.ride_km, 0.6);
  assert.ok(est.walk_min >= 7);
  assert.ok(est.ride_min >= 2);
});

test("estimateMrtAccessForPoint returns the nearest station and route-like distances", () => {
  const row = estimateMrtAccessForPoint(25.05781, 121.6184);
  assert.equal(row.station, "南港展覽館");
  assert.ok(row.walk_km > 0);
});

test("walkable MRT distance is under 1.5 km exclusive", () => {
  assert.equal(isWalkableMrtDistance(1.4), true);
  assert.equal(isWalkableMrtDistance(1.5), false);
  assert.equal(isWalkableMrtDistance(1.6), false);
  assert.equal(isWalkableMrtDistance(0), false);
});

test("nearby walk candidates skip stations at or beyond 1.5 km straight-line", () => {
  const near = nearbyWalkMrtStations(25.05781, 121.6184);
  assert.ok(near.some((row) => row.name === "南港展覽館"));
  assert.ok(near.every((row) => row.straightKm < 1.5));
});

test("formatMrtAccess shows only station and walking kilometers", () => {
  const text = formatMrtAccess({
    station: "南港展覽館",
    walk_km: 0.5,
    walk_min: 7,
    ride_km: 0.6,
    ride_min: 2,
  });
  assert.equal(text, "捷運南港展覽館站 約 0.5 公里");
  assert.doesNotMatch(text, /步行/);
  assert.doesNotMatch(text, /·/);
  assert.doesNotMatch(text, /分/);
  assert.doesNotMatch(text, /騎車/);
  assert.equal(formatMrtAccess({ station: "南港展覽館", walk_km: 1.5 }), "");
  assert.equal(makeMrtKey(25.05781, 121.6184), "25.05781,121.6184");
});

test("fetchMrtAccess uses walking map routes and hides 1.5 km and farther", async () => {
  const calls = [];
  const access = await fetchMrtAccess(25.05781, 121.6184, {
    routeWalk: async (fromLat, fromLng, toLat, toLng) => {
      calls.push({ fromLat, fromLng, toLat, toLng });
      return { km: 0.8 };
    },
  });
  assert.ok(calls.length >= 1);
  assert.equal(access.station, "南港展覽館");
  assert.equal(access.walk_km, 0.8);
  assert.equal(access.ride_km, null);
  assert.equal(access.too_far, false);

  const far = await fetchMrtAccess(25.05781, 121.6184, {
    routeWalk: async () => ({ km: 1.5 }),
  });
  assert.equal(far.station, "");
  assert.equal(far.too_far, true);
  assert.equal(formatMrtAccess(far), "");

  const none = await fetchMrtAccess(24.9, 121.35, {
    routeWalk: async () => {
      throw new Error("should not route");
    },
  });
  assert.equal(none.too_far, true);
  assert.equal(none.station, "");
});

test("fetchMrtAccess picks the shortest walking route among nearby stations", async () => {
  const access = await fetchMrtAccess(25.05781, 121.6184, {
    routeWalk: async (_a, _b, toLat) => ({ km: Number(toLat) > 25.05 ? 1.2 : 0.4 }),
  });
  assert.ok(access.walk_km <= 1.2);
  assert.ok(isWalkableMrtDistance(access.walk_km));
  assert.ok(access.station);
});

test("A4：步行路線必須走 foot profile，1,000 公尺（含）才算符合", async () => {
  const { fetchMrtAccessWithin, isMrtAccessWithin, MRT_ACCESS_MAX_M, MRT_ROUTE_SOURCE } = await import("../src/mrt.js");
  assert.equal(MRT_ACCESS_MAX_M, 1000);
  assert.equal(MRT_ROUTE_SOURCE, "osrm-foot");
  // 邊界：剛好 1,000 公尺可以；1,001 不行；0（同一點）可以；負值／NaN 不行
  assert.equal(isMrtAccessWithin(1000), true);
  assert.equal(isMrtAccessWithin(1001), false);
  assert.equal(isMrtAccessWithin(0), true);
  assert.equal(isMrtAccessWithin(-1), false);
  assert.equal(isMrtAccessWithin(NaN), false);

  // 直線距離是步行距離的下界 ⇒ 直線就超過 1 公里的站不必打外部服務（這裡用一個沒有捷運站的點）
  let routeCalls = 0;
  const far = await fetchMrtAccessWithin(24.10, 120.70, {
    routeWalk: () => { routeCalls += 1; throw new Error("不該呼叫路線服務"); },
  });
  assert.equal(far.status, "none");
  assert.equal(far.resolved, true);
  assert.equal(routeCalls, 0);

  // 有候選站時用**真實步行結果**判定，不是直線
  const calls = [];
  const fakeRoute = (km) => (fromLat, fromLng, toLat, toLng) => {
    calls.push([toLat, toLng]);
    return { km, meters: Math.round(km * 1000) };
  };
  const within = await fetchMrtAccessWithin(25.0478, 121.5170, { routeWalk: fakeRoute(0.62) });
  assert.equal(within.status, "within");
  assert.equal(within.walk_m, 620);
  assert.equal(within.source, MRT_ROUTE_SOURCE);
  assert.ok(calls.length >= 1);

  const over = await fetchMrtAccessWithin(25.0478, 121.5170, { routeWalk: fakeRoute(1.2) });
  assert.equal(over.status, "none");
  assert.equal(over.resolved, true);

  // 路線服務沒有可用結果 ⇒ 只能是 unknown（待確認），不能當成「符合」或「確定沒有」
  const broken = await fetchMrtAccessWithin(25.0478, 121.5170, { routeWalk: () => null });
  assert.equal(broken.status, "unknown");
  assert.equal(broken.resolved, false);
  // 服務忙碌（429）也是 unknown
  const busy = await fetchMrtAccessWithin(25.0478, 121.5170, { routeWalk: () => ({ busy: true }) });
  assert.equal(busy.status, "unknown");
  assert.equal(busy.busy, true);

  // 取所有候選站中最短的那一條
  let i = 0;
  const descending = () => { i += 1; return { km: i === 1 ? 1.4 : 0.9, meters: i === 1 ? 1400 : 900 }; };
  const best = await fetchMrtAccessWithin(25.0478, 121.5170, { routeWalk: descending });
  assert.equal(best.status, "within");
  assert.equal(best.walk_m, 900);
});

test("A4：不得再使用只跑車用 profile 的公開 OSRM 示範站", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/mrt.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /router\.project-osrm\.org/, "公開示範站忽略 profile，會拿車程冒充步行");
  assert.match(src, /routed-foot/);
  assert.match(src, /MRT_FOOT_ROUTE_BASE/);
});

test("A4：刊登表單的捷運查詢要有狀態機、去抖、丟棄過期回應與重試", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="selfMrtAccess"/);
  assert.match(html, /id="selfMrtAccessText"/);
  assert.match(html, /id="selfMrtRetry"/);
  assert.match(html, /const MRT_ACCESS_DEBOUNCE_MS = 900/);
  // 五種狀態要分得開（未查證 ≠ 符合 ≠ 確定沒有）：
  // 前端自己產生的三個直接寫死，後端回的狀態由 data-state 樣式與通用分支處理。
  for (const state of ["loading", "pending", "error"]) {
    assert.match(html, new RegExp(`paintMrtAccess\\("${state}"`), `缺少狀態 ${state}`);
  }
  assert.match(html, /paintMrtAccess\(status, data\.message/);
  for (const state of ["within", "none", "unknown", "unlocatable"]) {
    assert.match(html, new RegExp(`\\.mrt-access\\[data-state="${state}"\\]`), `缺少樣式狀態 ${state}`);
  }
  // 地址一改就清舊結果；較早的回應不能覆蓋最新地址
  assert.match(html, /let mrtAccessSeq = 0/);
  assert.match(html, /if \(seq !== mrtAccessSeq \|\| String\(addrEl\?\.value \|\| ""\)\.trim\(\) !== address\) return null;/);
  assert.match(html, /const seq = \+\+mrtAccessSeq;/);
  // 只打自家端點，不直接打外部服務
  assert.match(html, /\/api\/self-listings\/mrt-access\?address=/);
  assert.doesNotMatch(html, /routing\.openstreetmap\.de/);
});

test("A4：查詢端點必須註冊在 /api/self-listings/:id 之前（否則會被當成 id）", async () => {
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const mrt = server.indexOf('app.get("/api/self-listings/mrt-access"');
  const byId = server.indexOf('app.get("/api/self-listings/:id"');
  assert.ok(mrt > 0 && byId > 0);
  assert.ok(mrt < byId, "mrt-access 必須在 :id 之前註冊");
  // 未登入不得使用（避免變成免費的地理編碼代理）
  assert.match(server, /app\.get\("\/api\/self-listings\/mrt-access", async \(req, res\) => \{\s*\n\s*try \{\s*\n\s*const session = readSession\(req\);/);
  // 外部服務失敗要回可重試的狀態，不是 500
  assert.match(server, /status: "error", retryable: true, verified: false/);
});
