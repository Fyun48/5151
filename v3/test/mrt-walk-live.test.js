// A4：步行捷運查詢的**真實外部服務**驗證。
//
// 為什麼一定要有這一條：舊程式的 bug 正是「服務真的有回應、但回的是車用 profile」——
// mock 一定會過，只有打真的服務才看得出來。工作單也要求「需要外部步行服務的項目，
// 至少確認一個真實成功案例；不能只用 mock 宣稱外部整合已完成」。
//
// 兩個 ground truth（2026-10-01 以 OSM foot profile 實測，服務為 FOSSGIS 的 routed-foot）：
//   1. 台北 101／世貿站旁（25.0330, 121.5650）：直線 322 m、步行 330 m ⇒ **符合** 1 公里
//   2. 大直對岸（25.0720, 121.5480）：直線 843 m、步行 1,327 m ⇒ **不符合**
//      這一筆就是「直線很近但步行超過 1 公里」的案例，直線距離會誤判、真實路線不會。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mrtUrl = JSON.stringify(new URL("../src/mrt.js", import.meta.url).href);

function runIsolated(script, timeout = 40_000) {
  // 子程序會打外部服務；沒有 timeout 時一卡住 spawnSync 會永久阻塞（同 commute-route-live）。
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout,
    env: { ...process.env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.trim().split("\n").filter((row) => row.startsWith("{")).at(-1);
  return JSON.parse(line);
}

test("A4（live）：真實步行路線——101 旁符合、大直對岸直線近但步行超過 1 公里不符合", { timeout: 90_000 }, () => {
  const out = runIsolated(`
    const { fetchMrtAccessWithin } = await import(${mrtUrl});
    const near = await fetchMrtAccessWithin(25.0330, 121.5650);
    await new Promise((r) => setTimeout(r, 1200));
    const across = await fetchMrtAccessWithin(25.0720, 121.5480);
    console.log(JSON.stringify({ near, across }));
  `);
  // 1) 真實成功案例：查得到站名與步行距離，而且判定為「1 公里內」
  assert.equal(out.near.status, "within", `101 旁應該符合，實際 ${JSON.stringify(out.near)}`);
  assert.ok(out.near.station, "要回站名");
  assert.ok(out.near.walk_m > 0 && out.near.walk_m <= 1000, `步行距離應在 1 公里內，實際 ${out.near.walk_m}`);
  assert.equal(out.near.source, "osrm-foot");

  // 2) 直線近但步行遠：這裡直線 843 m（< 1000）但步行 1,327 m ⇒ 必須判成不符合
  assert.equal(out.across.status, "none", `大直對岸應判成不符合，實際 ${JSON.stringify(out.across)}`);
  assert.ok(out.across.walk_m > 1000, `步行距離應超過 1 公里，實際 ${out.across.walk_m}`);
});

test("A4（live）：同一組座標的 walking 與 driving 必須不同（證明真的用了 foot profile）", { timeout: 60_000 }, async () => {
  // 直接打服務比較兩個 profile。舊程式打的是忽略 profile 的示範站，兩者會**完全相同**。
  const base = "https://routing.openstreetmap.de";
  const path = "121.5490,25.0645;121.5510,25.0620";
  const get = async (profile) => {
    const res = await fetch(`${base}/routed-${profile}/route/v1/${profile}/${path}?overview=false`);
    assert.ok(res.ok, `路線服務沒有正常回應（${profile}）：${res.status}`);
    const body = await res.json();
    return Number(body.routes?.[0]?.distance);
  };
  const foot = await get("foot");
  await new Promise((r) => setTimeout(r, 1200));
  const car = await get("car");
  assert.ok(Number.isFinite(foot) && Number.isFinite(car));
  assert.notEqual(foot, car, "兩個 profile 的距離相同 ⇒ 服務忽略了 profile（會拿車程冒充步行）");
});

test("A4：mrt.js 會用環境變數覆寫路線服務（自架 OSRM 的退路）", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(fileURLToPath(new URL("../src/mrt.js", import.meta.url)), "utf8");
  assert.match(src, /process\.env\.MRT_FOOT_ROUTE_BASE/);
});
