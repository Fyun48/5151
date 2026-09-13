import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

function runIsolated(body) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-admin-ov-"));
  const script = `
    import assert from "node:assert/strict";
    import * as app from ${JSON.stringify(path.join(dir, "../src/db.js"))};
    import { getAdminOverview, getAdminDataHealth, searchAdminListings } from ${JSON.stringify(path.join(dir, "../src/adminOverview.js"))};
    import { appendAdminAudit, listAdminAudit, redactAuditValue } from ${JSON.stringify(path.join(dir, "../src/adminAudit.js"))};
    function seed(post_id, overrides = {}) {
      app.upsertListing({
        post_id, source: overrides.source || "591", source_id: String(post_id),
        source_key: "1|8|" + post_id, search_key: "https://example.test/search",
        title: "總覽測試 " + post_id, url: "https://example.test/" + post_id,
        price: "20000元", price_num: 20000, extra_fees: [],
        address: overrides.address ?? ("台北市士林區測試路" + post_id + "號"),
        area_name: overrides.area_name ?? "20坪",
        layout: overrides.layout ?? "2房1廳", floor_name: overrides.floor_name ?? "5/12",
        kind_name: "整層住家/電梯大樓",
        role_name: "", cover: "", tags: "[]",
        refresh_time: "2026-09-01T00:00:00.000Z",
        first_seen_at: "2026-09-01T00:00:00.000Z",
        last_seen_at: "2026-09-01T00:00:00.000Z", last_event: "new",
        ...overrides,
      });
    }
    ${body}
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("overview is read-only status and does not enable rakuya", () => {
  runIsolated(`
    seed(101);
    seed(102, { address: "", floor_name: "", area_name: "", layout: "" });
    const ov = getAdminOverview();
    assert.equal(ov.readOnly, true);
    assert.ok(ov.listings.total >= 2);
    const rakuya = ov.sources.find((row) => row.id === "rakuya");
    assert.equal(rakuya.enabled, false);
    assert.match(rakuya.reason, /Owner 手動停用/);
    const health = getAdminDataHealth();
    assert.ok(health.missingAddress >= 1);
    const hits = searchAdminListings("總覽測試 101");
    assert.equal(hits[0].post_id, 101);
    const secret = redactAuditValue({ smtpPass: "secret", host: "smtp.example.com" });
    assert.equal(secret.smtpPass, "[redacted]");
    assert.equal(secret.host, "smtp.example.com");
    appendAdminAudit({ actorEmail: "jimmy@example.test", action: "crawl_sources_save", target: "rakuya" });
    assert.equal(listAdminAudit({ limit: 1 })[0].action, "crawl_sources_save");
    const src = app.getCrawlSources().items.find((row) => row.id === "rakuya");
    assert.equal(src.enabled, false);
  `);
});

test("admin same-house confirm remains a shared global confirm", () => {
  runIsolated(`
    seed(201);
    seed(202);
    const admin = app.defaultUserId();
    const result = app.mergeSameHouseForUser(admin, [201, 202], { admin: true });
    assert.equal(result.ok, true);
    assert.equal(result.shared, true);
  `);
});
