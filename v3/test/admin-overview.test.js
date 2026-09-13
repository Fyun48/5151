import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

function runIsolated(body) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-admin-ov-"));
  const script = `
    import assert from "node:assert/strict";
    import * as app from ${JSON.stringify(path.join(dir, "../src/db.js"))};
    import { getAdminOverview, getAdminDataHealth, searchAdminListings, remainingSameHouseBackfill } from ${JSON.stringify(path.join(dir, "../src/adminOverview.js"))};
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
    const s591 = ov.sources.find((row) => row.id === "591");
    assert.equal(s591.enabled, true);
    assert.equal(s591.status, "unchecked");
    assert.match(s591.statusLabel, /未檢查/);
    assert.equal(ov.services.osrm.status, "unchecked");
    assert.match(ov.services.osrm.statusLabel, /未檢查/);
    assert.notEqual(ov.services.osrm.statusLabel, "正常");
    const health = getAdminDataHealth();
    assert.ok(health.missingAddress >= 1);
    const hits = searchAdminListings("總覽測試 101");
    assert.equal(hits[0].post_id, 101);
    const secret = redactAuditValue({ smtpPass: "secret", host: "smtp.example.com" });
    assert.equal(secret.smtpPass, "[redacted]");
    assert.equal(secret.host, "smtp.example.com");
    appendAdminAudit({ actorEmail: "jimmy@example.test", action: "crawl_sources_save", target: "rakuya" });
    appendAdminAudit({ actorEmail: "jimmy@example.test", action: "same_house_confirm", target: "201,202" });
    const audit = listAdminAudit({ limit: 10 });
    assert.equal(audit.some((row) => row.action === "crawl_sources_save"), true);
    assert.equal(audit.some((row) => row.action === "same_house_confirm"), true);
    assert.equal(listAdminAudit({ limit: 1 })[0].action, "same_house_confirm");
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

test("pendingReconcile counts remaining post_id > cursor, not listings minus cursor", () => {
  runIsolated(`
    seed(10);
    seed(50);
    seed(9000);
    app.db.prepare(
      "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run("sameHouseBackfillCursor", JSON.stringify("50"));
    assert.equal(remainingSameHouseBackfill(50), 1);
    assert.equal(remainingSameHouseBackfill(9), 3);
    assert.equal(remainingSameHouseBackfill(9000), 0);
    const ov = getAdminOverview();
    assert.equal(ov.listings.pendingReconcile, 1);
    assert.notEqual(ov.listings.pendingReconcile, 0);
    assert.notEqual(ov.listings.total - 50, ov.listings.pendingReconcile);
  `);
});

test("legacy adminAudit JSON migrates with BEGIN IMMEDIATE on node:sqlite", () => {
  runIsolated(`
    import { lastAuditAction } from ${JSON.stringify(path.join(dir, "../src/adminAudit.js"))};
    import { ADMIN_AUDIT_LEGACY_KEY, migrateLegacyAdminAudit } from ${JSON.stringify(path.join(dir, "../src/adminAuditSchema.js"))};
    assert.equal(typeof app.db.transaction, "undefined");
    const legacy = [
      { at: "2026-09-01T00:00:00.000Z", actorId: 1, actorEmail: "a@example.test", action: "smtp_test", target: "mail" },
      { at: "2026-09-02T00:00:00.000Z", actorId: 1, actorEmail: "a@example.test", action: "crawl_sources_save", target: "591" },
    ];
    app.db.prepare(
      "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(ADMIN_AUDIT_LEGACY_KEY, JSON.stringify(legacy));
    const before = getAdminOverview();
    assert.equal(before.readOnly, true);
    assert.equal(lastAuditAction("smtp_test"), null);
    assert.ok(app.db.prepare("SELECT value FROM settings WHERE key = ?").get(ADMIN_AUDIT_LEGACY_KEY));
    const result = migrateLegacyAdminAudit(app.db);
    assert.equal(result.migrated, 2);
    assert.equal(app.db.prepare("SELECT value FROM settings WHERE key = ?").get(ADMIN_AUDIT_LEGACY_KEY), undefined);
    assert.equal(lastAuditAction("smtp_test")?.action, "smtp_test");
    assert.equal(listAdminAudit({ limit: 10 }).length, 2);
  `);
});

test("startup migrates leftover adminAudit JSON without DatabaseSync.transaction", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-admin-audit-boot-"));
  mkdirSync(dataDir, { recursive: true });
  const boot = new DatabaseSync(path.join(dataDir, "v3.db"));
  boot.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  boot.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run(
    "adminAuditLog",
    JSON.stringify([
      { at: "2026-09-03T00:00:00.000Z", actorEmail: "boot@example.test", action: "smtp_test", target: "mail" },
    ]),
  );
  boot.close();
  const script = `
    import assert from "node:assert/strict";
    import { lastAuditAction, listAdminAudit } from ${JSON.stringify(path.join(dir, "../src/adminAudit.js"))};
    import { ADMIN_AUDIT_LEGACY_KEY } from ${JSON.stringify(path.join(dir, "../src/adminAuditSchema.js"))};
    import { db } from ${JSON.stringify(path.join(dir, "../src/db.js"))};
    assert.equal(typeof db.transaction, "undefined");
    assert.equal(lastAuditAction("smtp_test")?.action, "smtp_test");
    assert.equal(listAdminAudit({ limit: 5 }).length, 1);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = ?").get(ADMIN_AUDIT_LEGACY_KEY), undefined);
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
});
