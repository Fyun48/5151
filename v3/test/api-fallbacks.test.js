// `/api/*` 的 JSON 保底（2026-09-30，第八十九批）。
//
// 正式站實際回報的症狀：頁面某處顯示
//   `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
// 根因有兩層：
//   1. **伺服器**：`/api/*` 的未知路徑與未被 try/catch 接住的例外，都回 Express 預設的 **HTML**
//      （`/api/me` 就是沒有 try/catch 的那一條，而它是前端啟動路徑的第一支請求）。
//   2. **前端**：多處用 `res.json()` 直接讀，遇到 HTML 就爆出上面那句天書。
// 這一包把兩層都釘住：伺服器一律回 JSON，前端啟動路徑改走 `readApi()`（它會把 HTML 換成
// 「伺服器沒有正確回應，請重新整理後再試」）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  GENERIC_SERVER_ERROR,
  apiErrorBody,
  apiErrorHandler,
  apiNotFoundHandler,
  statusOfApiError,
} = await import("../src/apiFallbacks.js");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

/** 假的 Express res：記下 status／json／headersSent。 */
function fakeRes({ headersSent = false } = {}) {
  const calls = { status: null, json: null, headersSent };
  return {
    calls,
    headersSent,
    status(code) { calls.status = code; return this; },
    json(body) { calls.json = body; return this; },
  };
}
const fakeReq = (method, p) => ({ method, path: p, url: p, originalUrl: p });

test("apiErrorBody：4xx 沿用路由訊息、5xx 換成通用句且不外洩內部訊息", () => {
  const notFound = apiErrorBody(Object.assign(new Error("找不到這則刊登"), { status: 404, code: "listing_not_found" }));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error, "找不到這則刊登");
  assert.equal(notFound.body.code, "listing_not_found");

  const boom = apiErrorBody(new Error("pg: relation \"listings\" does not exist"));
  assert.equal(boom.status, 500);
  assert.equal(boom.body.error, GENERIC_SERVER_ERROR);
  assert.equal(boom.body.code, "internal");
  assert.ok(!JSON.stringify(boom.body).includes("relation"), "5xx 不得把內部訊息送給前端");

  const teapot = apiErrorBody(Object.assign(new Error("我是茶壺"), { statusCode: 418 }));
  assert.equal(teapot.status, 418, "statusCode 也要認");
  assert.equal(teapot.body.error, "我是茶壺");
});

test("apiErrorBody：奇怪的 status 一律回 500（不是 0、不是 NaN）", () => {
  for (const bad of [undefined, null, 0, 200, 302, 999, "abc", -1]) {
    const out = apiErrorBody(Object.assign(new Error("x"), { status: bad }));
    assert.equal(out.status, 500, `status=${String(bad)} 應視為 500`);
  }
  assert.equal(statusOfApiError({ status: 403 }), 403);
  assert.equal(statusOfApiError({}), 500);
});

test("apiErrorBody：body-parser 的 JSON 解析錯誤要變成人看得懂的 400", () => {
  const parseError = Object.assign(new SyntaxError("Unexpected token < in JSON at position 0"), {
    status: 400,
    type: "entity.parse.failed",
  });
  const out = apiErrorBody(parseError);
  assert.equal(out.status, 400);
  assert.equal(out.body.error, "請求內容格式不正確");

  const tooLarge = Object.assign(new Error("request entity too large"), { status: 413, type: "entity.too.large" });
  assert.equal(apiErrorBody(tooLarge).body.error, "請求內容過大");
});

test("apiNotFoundHandler：未知的 /api 路徑回 JSON 404（不是 HTML）", () => {
  const res = fakeRes();
  const nextCalls = [];
  apiNotFoundHandler()(fakeReq("GET", "/api/nope"), res, (e) => nextCalls.push(e));
  assert.equal(res.calls.status, 404);
  assert.deepEqual(res.calls.json, { error: "找不到這個 API 路徑", code: "api_not_found" });
  assert.deepEqual(nextCalls, [], "不該把 404 丟給後面的中介層");
});

test("apiErrorHandler：/api 回 JSON、非 /api 交還 Express 預設（HTML 導覽不受影響）", () => {
  const logs = [];
  const logger = { error: (line) => logs.push(line) };
  const handler = apiErrorHandler({ logger });

  const apiRes = fakeRes();
  handler(Object.assign(new Error("壞了"), { status: 503, code: "pg_down" }), fakeReq("GET", "/api/settings"), apiRes, () => {
    assert.fail("API 路徑不該走 next（要由這裡回 JSON）");
  });
  assert.equal(apiRes.calls.status, 503);
  // 5xx 對外只給通用句（內部訊息留在 log）
  assert.deepEqual(apiRes.calls.json, { error: GENERIC_SERVER_ERROR, code: "pg_down" });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[api\] GET \/api\/settings → 503 pg_down :: 壞了/);

  // 4xx 的使用者訊息要原樣保留（路由本來就是寫給人看的）
  const badRes = fakeRes();
  handler(Object.assign(new Error("請先登入"), { status: 401, code: "login_required" }), fakeReq("GET", "/api/watch/list"), badRes, () => {});
  assert.equal(badRes.calls.status, 401);
  assert.deepEqual(badRes.calls.json, { error: "請先登入", code: "login_required" });

  const pageRes = fakeRes();
  const forwarded = [];
  handler(new Error("壞了"), fakeReq("GET", "/admin.html"), pageRes, (error) => forwarded.push(error));
  assert.equal(forwarded.length, 1, "非 API 路徑要交還 Express（HTML 404／錯誤頁維持原狀）");
  assert.equal(pageRes.calls.status, null);
  assert.equal(pageRes.calls.json, null);
});

test("apiErrorHandler：headersSent 之後不插話、log 失敗也不影響回應", () => {
  const forwarded = [];
  const handler = apiErrorHandler({ logger: { error: () => { throw new Error("log 爆了"); } } });
  handler(new Error("x"), fakeReq("GET", "/api/x"), fakeRes({ headersSent: true }), (e) => forwarded.push(e));
  assert.equal(forwarded.length, 1, "headersSent 時要交還 Express");

  const res = fakeRes();
  handler(Object.assign(new Error("y"), { status: 400 }), fakeReq("POST", "/api/y"), res, () => {});
  assert.equal(res.calls.status, 400, "logger 丟錯不該讓回應消失");
  assert.equal(res.calls.json.error, "y");
});

test("server.js 接線：JSON 404 在靜態檔之前、錯誤中介層在最後", () => {
  const server = read("v3/src/server.js");
  assert.ok(server.includes('import { apiErrorHandler, apiNotFoundHandler, statusOfApiError } from "./apiFallbacks.js";'),
    "要 import 兩個保底 handler（與 /api/me 用的 status 判定）");
  const notFoundAt = server.indexOf('app.use("/api", apiNotFoundHandler());');
  const staticAt = server.indexOf('app.use(express.static(path.join(__dirname, "../public")));');
  const errorAt = server.indexOf("app.use(apiErrorHandler());");
  assert.ok(notFoundAt > 0 && staticAt > 0 && errorAt > 0, "三個都必須存在");
  assert.ok(notFoundAt < staticAt, "JSON 404 必須在靜態檔之前（否則 /api/* 會被當檔案找）");
  assert.ok(errorAt > staticAt, "錯誤中介層必須最後註冊（Express 只認最後一個）");
  assert.ok(errorAt > notFoundAt);
});

test("server.js：/api/me 有 try/catch（啟動路徑不得回 HTML）", () => {
  const server = read("v3/src/server.js");
  const start = server.indexOf('app.get("/api/me"');
  const end = server.indexOf('app.patch("/api/profile"', start);
  assert.ok(start > 0 && end > start, "找得到 /api/me");
  const body = server.slice(start, end);
  assert.match(body, /try \{/, "/api/me 必須包 try");
  assert.match(body, /statusOfApiError\(error\)/, "catch 要用共用的狀態碼判定");
  assert.match(body, /res\.status\(statusOfApiError\(error\)\)\.json\(/, "catch 必須回 JSON");
});

test("前端啟動路徑：/api/me 與列表用 readApi()（HTML 回應不再變成天書）", () => {
  const html = read("v3/public/index.html");
  const meAt = html.indexOf('const res = await fetch("/api/me", { cache: "no-store"');
  assert.ok(meAt > 0, "找得到啟動路徑的 /api/me");
  const meBlock = html.slice(meAt, meAt + 600);
  assert.match(meBlock, /me = await readApi\(res\);/, "/api/me 要用 readApi()");
  assert.doesNotMatch(meBlock, /me = await res\.json\(\);/, "不得再用 raw res.json()");

  for (const [label, needle] of [
    ["會員列表", "const data = await readApi(res);\n        if (gen !== listLoadGen) return;"],
    ["設定檔載入", "const data = await readApi(res);\n        if (!res.ok) throw new Error(data.error || \"載入失敗\");"],
    ["設定檔刪除", "const data = await readApi(res);\n        if (!res.ok) throw new Error(data.error || \"刪除失敗\");"],
    ["併入同房源", "const data = await readApi(res);\n        if (!res.ok) throw new Error(data.error || \"併入失敗\");"],
  ]) {
    assert.ok(html.includes(needle), `${label} 也要走 readApi()`);
  }
});
