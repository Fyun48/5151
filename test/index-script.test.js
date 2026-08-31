import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("index.html inline script parses", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  assert.ok(blocks.length, "missing script");
  for (const source of blocks) {
    const trimmed = source.trim();
    if (!trimmed) continue;
    assert.doesNotThrow(() => new Function(source));
  }
});
