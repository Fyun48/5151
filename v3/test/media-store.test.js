// mediaStore 的行為測試（離線：攔截 fetch，不連 R2）。
//
// 釘住的重點：
//  1. `_o.jpg`（未浮水印原圖）**永遠**不會被上傳或刪除（資安）。
//  2. 預設 local＝完全不碰網路；r2 模式才動作，且快取標頭是 7 天。
//  3. r2 模式下上傳失敗＝丟錯（呼叫端據此回滾）；local／明確 required:false 時只記錄。
//  4. 清除快取只在有 `R2_PURGE_TOKEN` 時執行，且只送 https 網址、最多 25 筆。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEMBER_MEDIA_CACHE_CONTROL,
  deleteMemberMediaObjects,
  isCdnServing,
  mediaServeMode,
  memberMediaCdnUrl,
  purgeMediaUrls,
  putMemberMediaObjects,
  r2KeyForMemberMedia,
} from "../src/media/mediaStore.js";

const HASH = "a".repeat(32);
const ENV = {
  MEDIA_SERVE: "r2",
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "AKIAEXAMPLE",
  R2_SECRET_ACCESS_KEY: "secretexample",
  R2_BUCKET: "5151-media",
  R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  R2_MEDIA_DOMAIN: "https://media.example.com",
  R2_ZONE_ID: "zone1",
  R2_PURGE_TOKEN: "purge-token",
};

function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body };
    calls.push(call);
    return handler(call);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const okResponse = () => new Response("", { status: 200 });
const jsonResponse = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });

test("mediaServeMode：預設 local，只有 MEDIA_SERVE=r2 才是 r2", () => {
  assert.equal(mediaServeMode({}), "local");
  assert.equal(mediaServeMode({ MEDIA_SERVE: "" }), "local");
  assert.equal(mediaServeMode({ MEDIA_SERVE: "R2 " }), "r2");
  assert.equal(mediaServeMode({ MEDIA_SERVE: "cloudflare" }), "local");
});

test("isCdnServing：r2 模式但憑證不全 → 視為停用（回退本機）", () => {
  assert.equal(isCdnServing(ENV), true);
  assert.equal(isCdnServing({ ...ENV, R2_SECRET_ACCESS_KEY: "" }), false);
  assert.equal(isCdnServing({ ...ENV, MEDIA_SERVE: "local" }), false);
});

test("r2KeyForMemberMedia：只有公開顯示檔有金鑰，_o.jpg 與跳脫路徑一律空字串", () => {
  assert.equal(r2KeyForMemberMedia(`${HASH}.jpg`), `member-media/${HASH}.jpg`);
  assert.equal(r2KeyForMemberMedia(`${HASH}_t.jpg`), `member-media/${HASH}_t.jpg`);
  assert.equal(r2KeyForMemberMedia(`${HASH}_o.jpg`), "");
  assert.equal(r2KeyForMemberMedia("../../secret.jpg"), "");
  assert.equal(r2KeyForMemberMedia("notahash.jpg"), "");
});

test("memberMediaCdnUrl：組出 CDN 網址；local 模式回空字串", () => {
  assert.equal(memberMediaCdnUrl(`${HASH}.jpg`, ENV), `https://media.example.com/member-media/${HASH}.jpg`);
  assert.equal(memberMediaCdnUrl(`${HASH}_o.jpg`, ENV), "");
  assert.equal(memberMediaCdnUrl(`${HASH}.jpg`, { ...ENV, MEDIA_SERVE: "local" }), "");
});

test("putMemberMediaObjects：local 模式完全不碰網路", async () => {
  const stub = stubFetch(() => okResponse());
  try {
    const result = await putMemberMediaObjects([{ name: `${HASH}.jpg`, buffer: Buffer.from("x") }], { env: {} });
    assert.equal(result.skipped, true);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("putMemberMediaObjects：r2 模式簽章上傳公開顯示檔，跳過 _o.jpg，帶 7 天快取", async () => {
  const stub = stubFetch(() => okResponse());
  try {
    const result = await putMemberMediaObjects(
      [
        { name: `${HASH}.jpg`, buffer: Buffer.from("main") },
        { name: `${HASH}_t.jpg`, buffer: Buffer.from("thumb") },
        { name: `${HASH}_o.jpg`, buffer: Buffer.from("original") },
      ],
      { env: ENV },
    );
    assert.deepEqual(result, { skipped: false, uploaded: 2 });
    assert.equal(stub.calls.length, 2, "原圖不得上傳");
    assert.ok(stub.calls.every((c) => c.method === "PUT"));
    assert.ok(stub.calls.every((c) => c.url.includes("/5151-media/member-media/")));
    assert.ok(stub.calls.every((c) => String(c.headers.Authorization).startsWith("AWS4-HMAC-SHA256 ")));
    assert.ok(stub.calls.every((c) => c.headers["cache-control"] === MEMBER_MEDIA_CACHE_CONTROL));
    assert.equal(stub.calls.some((c) => c.url.includes("_o.jpg")), false);
  } finally {
    stub.restore();
  }
});

test("putMemberMediaObjects：r2 模式失敗要丟錯；required:false 只記錄", async () => {
  const stub = stubFetch(() => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }));
  try {
    await assert.rejects(
      () => putMemberMediaObjects([{ name: `${HASH}.jpg`, buffer: Buffer.from("x") }], { env: ENV }),
      /AccessDenied|403/,
    );
    const soft = await putMemberMediaObjects(
      [{ name: `${HASH}.jpg`, buffer: Buffer.from("x") }],
      { env: ENV, required: false },
    );
    assert.deepEqual(soft, { skipped: false, uploaded: 0 });
  } finally {
    stub.restore();
  }
});

test("deleteMemberMediaObjects：刪除公開顯示檔，預設失敗不丟錯", async () => {
  const stub = stubFetch(() => new Response(null, { status: 204 }));
  try {
    const result = await deleteMemberMediaObjects([`${HASH}.jpg`, `${HASH}_t.jpg`, `${HASH}_o.jpg`], { env: ENV });
    assert.equal(result.deleted, 2);
    assert.equal(stub.calls.filter((c) => c.method === "DELETE").length, 2);
  } finally {
    stub.restore();
  }

  const failing = stubFetch(() => new Response("nope", { status: 500 }));
  try {
    const soft = await deleteMemberMediaObjects([`${HASH}.jpg`], { env: ENV });
    assert.equal(soft.deleted, 0);
    await assert.rejects(
      () => deleteMemberMediaObjects([`${HASH}.jpg`], { env: ENV, required: true }),
      /500/,
    );
  } finally {
    failing.restore();
  }
});

test("purgeMediaUrls：只送 https、上限 25 筆、沒有 token 就略過", async () => {
  const stub = stubFetch(() => jsonResponse({ success: true, result: { id: "p1" } }));
  try {
    const many = Array.from({ length: 30 }, (_, i) => `https://media.example.com/f${i}.jpg`);
    const result = await purgeMediaUrls([...many, "not-a-url", ""], { env: ENV });
    assert.equal(result.purged, 25);
    assert.equal(stub.calls.length, 1);
    const sent = JSON.parse(stub.calls[0].body);
    assert.equal(sent.files.length, 25);
    assert.ok(sent.files.every((f) => f.startsWith("https://")));
    assert.match(stub.calls[0].url, /\/zones\/zone1\/purge_cache$/);
    assert.equal(stub.calls[0].headers.Authorization, "Bearer purge-token");
  } finally {
    stub.restore();
  }

  const none = stubFetch(() => okResponse());
  try {
    const skipped = await purgeMediaUrls(["https://media.example.com/a.jpg"], { env: { ...ENV, R2_PURGE_TOKEN: "" } });
    assert.equal(skipped.skipped, true);
    assert.equal(none.calls.length, 0);
  } finally {
    none.restore();
  }
});
