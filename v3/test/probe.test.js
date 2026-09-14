import { test } from "node:test";
import assert from "node:assert/strict";
import { probeHtmlListingAlive, probeHtmlListingOutcome, probeListingAliveBySource } from "../src/probe.js";
import { PROBE_ALIVE, PROBE_GONE, PROBE_INCONCLUSIVE } from "../src/probeOutcomes.js";

function mockFetch(fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  return () => { globalThis.fetch = orig; };
}
const resp = ({ status = 200, url = "", body = "" }) => ({ status, ok: status >= 200 && status < 300, url, text: async () => body });

test("probeHtmlListingOutcome: 404/410 → gone; 403/429/5xx/timeout → inconclusive", async () => {
  let restore = mockFetch(async () => resp({ status: 404 }));
  assert.equal((await probeHtmlListingOutcome("https://x/detail")).outcome, PROBE_GONE);
  restore();
  restore = mockFetch(async () => resp({ status: 410 }));
  assert.equal((await probeHtmlListingOutcome("https://x/detail")).outcome, PROBE_GONE);
  restore();
  for (const status of [403, 429, 500, 503]) {
    restore = mockFetch(async () => resp({ status }));
    const { outcome } = await probeHtmlListingOutcome("https://x/detail");
    assert.equal(outcome, PROBE_INCONCLUSIVE, `status ${status} must stay inconclusive`);
    assert.equal(await probeHtmlListingAlive("https://x/detail"), false, `status ${status} is not confirmed alive`);
    restore();
  }
});

test("probeHtmlListingAlive: normal 200 → alive; explicit gone text → gone", async () => {
  let restore = mockFetch(async () => resp({ status: 200, url: "https://x/detail", body: "<html>正常出租物件 3房2廳 19坪 月租28000</html>" }));
  assert.equal(await probeHtmlListingAlive("https://x/detail"), true);
  restore();
  restore = mockFetch(async () => resp({ status: 200, url: "https://x/detail", body: "<html>物件已下架</html>" }));
  assert.equal(await probeHtmlListingAlive("https://x/detail"), false);
  restore();
});

test("probeHtmlListingAlive: redirect to a 'gone' marker page → gone (housefun noobject)", async () => {
  const restore = mockFetch(async () => resp({ status: 200, url: "https://rent.housefun.com.tw/nosupport/noobject.aspx", body: "" }));
  assert.equal(await probeHtmlListingAlive("https://rent.housefun.com.tw/rent/house/1/", { redirectGoneMarkers: ["noobject"] }), false);
  restore();
});

test("probeHtmlListingOutcome: non-empty SPA shell without listing fields is not alive", async () => {
  const restore = mockFetch(async () => resp({ status: 200, url: "https://x/detail", body: "<html><div id=app>出租中</div></html>" }));
  assert.equal((await probeHtmlListingOutcome("https://x/detail")).outcome, PROBE_INCONCLUSIVE);
  restore();
});

test("S8 nested recommend card is not treated as the main listing", async () => {
  const restore = mockFetch(async () => resp({
    status: 200,
    url: "https://x/detail",
    body: `<html><main></main><section class="recommend"><div class="heading">推薦</div><article><p>3房、19坪、月租28000</p></article></section></html>`,
  }));
  assert.equal((await probeHtmlListingOutcome("https://x/detail")).outcome, PROBE_INCONCLUSIVE);
  restore();
});

test("S8 empty template remains inconclusive and a normal main listing stays alive", async () => {
  let restore = mockFetch(async () => resp({
    status: 200,
    url: "https://x/detail",
    body: "<html><main></main><template>月租 樓層 搜尋 3房 19坪</template></html>",
  }));
  assert.equal((await probeHtmlListingOutcome("https://x/detail")).outcome, PROBE_INCONCLUSIVE);
  restore();
  restore = mockFetch(async () => resp({
    status: 200,
    url: "https://x/detail",
    body: "<html><main>正常出租物件 3房2廳 19坪 月租28000</main></html>",
  }));
  assert.equal((await probeHtmlListingOutcome("https://x/detail")).outcome, PROBE_ALIVE);
  restore();
});

test("S8 empty main with template labels is not alive", async () => {
  const restore = mockFetch(async () => resp({
    status: 200,
    url: "https://x/detail",
    body: "<html><main></main><template>月租 樓層 搜尋</template></html>",
  }));
  assert.equal((await probeHtmlListingOutcome("https://x/detail")).outcome, PROBE_INCONCLUSIVE);
  restore();
});

test("probeHtmlListingOutcome: a lone rent word in SPA chrome is not alive", async () => {
  const restore = mockFetch(async () => resp({
    status: 200,
    url: "https://x/detail",
    body: "<html><nav>租金</nav><div id=app></div></html>",
  }));
  assert.equal((await probeHtmlListingOutcome("https://x/detail")).outcome, PROBE_INCONCLUSIVE);
  restore();
});

test("probeHtmlListingOutcome: network error/timeout/captcha/empty shell → inconclusive", async () => {
  let restore = mockFetch(async () => { throw new Error("timeout"); });
  assert.equal((await probeHtmlListingOutcome("https://x/detail")).outcome, PROBE_INCONCLUSIVE);
  restore();
  restore = mockFetch(async () => resp({ status: 200, body: "<html>Just a moment... cloudflare captcha</html>" }));
  assert.equal((await probeHtmlListingOutcome("https://x/detail")).outcome, PROBE_INCONCLUSIVE);
  restore();
  restore = mockFetch(async () => resp({ status: 200, body: "" }));
  assert.equal((await probeHtmlListingOutcome("https://x/detail")).outcome, PROBE_INCONCLUSIVE);
  restore();
});

test("probeListingAliveBySource: self and unknown sources are unsupported (no false offline)", async () => {
  assert.deepEqual(await probeListingAliveBySource({ source: "self", url: "#self-1" }), {
    supported: false, outcome: null, alive: null,
  });
  assert.deepEqual(await probeListingAliveBySource({ source: "weird", url: "https://x/y" }), {
    supported: false, outcome: null, alive: null,
  });
});

test("probeListingAliveBySource: external HTML platforms dispatch (404 → gone; 200 → alive; 403 → inconclusive)", async () => {
  for (const source of ["hbhousing", "sinyi", "ddroom", "housefun"]) {
    let restore = mockFetch(async () => resp({ status: 404 }));
    assert.deepEqual(await probeListingAliveBySource({ source, url: "https://x/detail" }), {
      supported: true, outcome: PROBE_GONE, alive: false,
    }, `${source} 404`);
    restore();
    restore = mockFetch(async () => resp({ status: 200, url: "https://x/detail", body: "<html>出租中 3房2廳 25坪 月租18000</html>" }));
    assert.deepEqual(await probeListingAliveBySource({ source, url: "https://x/detail" }), {
      supported: true, outcome: PROBE_ALIVE, alive: true,
    }, `${source} 200`);
    restore();
    restore = mockFetch(async () => resp({ status: 403 }));
    assert.deepEqual(await probeListingAliveBySource({ source, url: "https://x/detail" }), {
      supported: true, outcome: PROBE_INCONCLUSIVE, alive: null,
    }, `${source} 403`);
    restore();
  }
});

test("probeListingAliveBySource: housefun redirect to noobject → gone", async () => {
  const restore = mockFetch(async () => resp({ status: 200, url: "https://rent.housefun.com.tw/nosupport/noobject.aspx" }));
  assert.deepEqual(await probeListingAliveBySource({ source: "housefun", url: "https://rent.housefun.com.tw/rent/house/1/" }), {
    supported: true, outcome: PROBE_GONE, alive: false,
  });
  restore();
});
