import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

test("production diagnostic performs one request, reports a block, and does not modify the database", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rakuya-diagnostic-"));
  const file = path.join(dir, "v3.db");
  try {
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE listings(source TEXT); INSERT INTO listings VALUES ('housefun'), ('housefun'), ('ddroom')");
    db.close();
    const before = readFileSync(file);
    const script = `
      import assert from 'node:assert/strict';
      let requests = 0;
      globalThis.fetch = async (url, options) => {
        requests++;
        assert.equal(new URL(url).hostname, 'rent.rakuya.com.tw');
        assert.equal(new URL(url).searchParams.get('city'), '0');
        assert.ok(options.signal);
        return { status: 403, text: async () => '<title>Just a moment...</title><div id="cf-chl-running">Checking your browser</div>' };
      };
      await import(${JSON.stringify(new URL("../diagnose-rakuya.mjs", import.meta.url).href)});
      assert.equal(requests, 1);
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, DATA_DIR: dir }, encoding: "utf8", timeout: 20000,
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.deepEqual(result.stored, { rakuya: 0, housefun: 2, ddroom: 1 });
    assert.equal(result.rakuya.http_status, 403);
    assert.equal(result.rakuya.code, "FETCH_BLOCKED");
    assert.equal(result.rakuya.parsed_records, 0);
    assert.deepEqual(readFileSync(file), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
