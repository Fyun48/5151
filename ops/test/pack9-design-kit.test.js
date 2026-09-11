import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { resolveKitStatic } from "../src/designKitStatic.js";
import {
  DESIGN_SYSTEM_ROOT,
  FORBIDDEN_RUNTIME,
  THEME_OVERRIDE_VARS,
  assertOfflineCss,
  assertThemeOnlyOverrides,
  packKit,
} from "../../design-system/scripts/pack-kit.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CFG = { ownerEmail: "owner@example.com", ownerPassword: "s3cret-pass", sessionSecret: "srv-secret" };

function read(rel) {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

function rootVars(css) {
  const block = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, "expected :root block");
  return Object.fromEntries(
    [...block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map((m) => [m[1], m[2].trim()]),
  );
}

async function withServer(run) {
  const db = openOpsDb(":memory:");
  const auth = makeAuth(CFG);
  const server = createApp({ db, auth }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base });
  } finally {
    server.close();
    db.close();
  }
}

test("kit version is semver and themes only override accent/bg/paper", () => {
  const version = read("design-system/kit/VERSION").trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  for (const name of ["v3", "ops", "example"]) {
    const css = read(`design-system/themes/${name}.css`);
    assertThemeOnlyOverrides(`themes/${name}.css`, css);
    assert.deepEqual(Object.keys(rootVars(css)).sort(), [...THEME_OVERRIDE_VARS].sort());
  }
});

test("pack-kit runs offline and matches committed snapshots", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "jibby-kit-"));
  try {
    const packed = packKit({ destRoots: [tmp], snapshot: false });
    assert.equal(packed.version, read("design-system/kit/VERSION").trim());
    for (const rel of packed.files) {
      const generated = readFileSync(path.join(tmp, rel), "utf8");
      assertOfflineCss(rel, generated);
      assert.equal(generated, read(path.join("v3/public/kit", rel)));
      assert.equal(generated, read(path.join("ops/public/kit", rel)));
      for (const re of FORBIDDEN_RUNTIME) assert.doesNotMatch(generated, re);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("v3 built-in tokens stay self-contained and aligned with kit :root", () => {
  const v3 = read("v3/public/tokens.css");
  const kit = read("design-system/tokens.css");
  assert.doesNotMatch(v3, /@import/);
  assert.doesNotMatch(v3, /url\(\s*['"]?https?:\/\//);
  for (const re of FORBIDDEN_RUNTIME) assert.doesNotMatch(v3, re);
  const v3Vars = rootVars(v3);
  const kitVars = rootVars(kit);
  for (const key of ["--bg", "--paper", "--accent", "--ink", "--touch"]) {
    assert.equal(v3Vars[key], kitVars[key], key);
  }
  assert.match(v3, /第 9 包反悔路徑/);
});

test("kit path resolver rejects traversal and unknown files", () => {
  assert.equal(resolveKitStatic("/kit/tokens.css")?.rel, "tokens.css");
  assert.equal(resolveKitStatic("/kit/themes/ops.css")?.rel, "themes/ops.css");
  assert.equal(resolveKitStatic("/kit/../console.js"), null);
  assert.equal(resolveKitStatic("/kit/themes/../../console.js"), null);
  assert.equal(resolveKitStatic("/kit/secret.css"), null);
  assert.equal(resolveKitStatic("/console.css"), null);
});

test("OPS console loads local kit snapshots, not a remote OPS URL", async () => {
  const html = read("ops/public/console.html");
  assert.match(html, /href="\/kit\/tokens\.css"/);
  assert.match(html, /href="\/kit\/themes\/ops\.css"/);
  assert.match(html, /href="\/kit\/components\.css"/);
  assert.match(html, /class="ds-btn ds-btn-primary primary"/);
  assert.doesNotMatch(html, /https?:\/\/[^"']+\/kit\//);
  for (const re of FORBIDDEN_RUNTIME) assert.doesNotMatch(html, re);

  await withServer(async ({ base }) => {
    const tokens = await fetch(`${base}/kit/tokens.css`);
    assert.equal(tokens.status, 200);
    assert.match(tokens.headers.get("content-type") || "", /text\/css/);
    assert.equal(tokens.headers.get("cache-control"), "no-store");
    assert.match(await tokens.text(), /--accent:\s*#0f6f6a/);
    const theme = await fetch(`${base}/kit/themes/ops.css`);
    assert.equal(theme.status, 200);
    assert.match(await theme.text(), /--accent:\s*#2f6f4f/);
    const missing = await fetch(`${base}/kit/not-a-file.css`);
    assert.equal(missing.status, 404);
    const traverse = await fetch(`${base}/kit/../console.js`);
    assert.notEqual(resolveKitStatic("/kit/../console.js")?.rel, "console.js");
    assert.ok(traverse.status === 200 || traverse.status === 404);
  });
});

test("layer 3 property-platform remains a separate product folder", () => {
  const master = read("design-system/property-platform/MASTER.md");
  assert.match(master, /吉比租房/);
  assert.match(read("design-system/kit/README.md"), /不要.*整包貼到別的產業/);
  assert.doesNotMatch(read("design-system/components.css"), /\.listing-row|\.wish-room|\.watch-quota/);
});
