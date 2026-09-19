#!/usr/bin/env node
/**
 * 離線打包 jibby-kit。不抓網路、不寫入 OPS URL。
 * node design-system/scripts/pack-kit.js
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DESIGN_SYSTEM_ROOT = path.join(here, "..");
export const REPO_ROOT = path.join(DESIGN_SYSTEM_ROOT, "..");
export const THEME_OVERRIDE_VARS = ["--accent", "--bg", "--paper"];
export const FORBIDDEN_RUNTIME = [
  /localhost:5154/i,
  /127\.0\.0\.1:5154/,
  /c5151\.reversalplay\.me/i,
];

function readVersion(sourceRoot = DESIGN_SYSTEM_ROOT) {
  const version = readFileSync(path.join(sourceRoot, "kit", "VERSION"), "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`kit VERSION must be semver x.y.z, got ${version}`);
  }
  return version;
}

export function kitSourceFiles(sourceRoot = DESIGN_SYSTEM_ROOT) {
  return [
    ["tokens.css", path.join(sourceRoot, "tokens.css")],
    ["components.css", path.join(sourceRoot, "components.css")],
    ["themes/v3.css", path.join(sourceRoot, "themes", "v3.css")],
    ["themes/ops.css", path.join(sourceRoot, "themes", "ops.css")],
    ["themes/example.css", path.join(sourceRoot, "themes", "example.css")],
    ["VERSION", path.join(sourceRoot, "kit", "VERSION")],
    ["README.md", path.join(sourceRoot, "kit", "README.md")],
    ["MANIFEST.json", path.join(sourceRoot, "kit", "MANIFEST.json")],
  ];
}

export function assertOfflineCss(rel, text) {
  for (const re of FORBIDDEN_RUNTIME) {
    if (re.test(text)) throw new Error(`${rel} must not reference OPS runtime hosts`);
  }
  if (/@import\s+url\(\s*['"]?https?:/i.test(text)) {
    throw new Error(`${rel} must not @import remote URLs`);
  }
  if (/url\(\s*['"]?https?:\/\//i.test(text)) {
    throw new Error(`${rel} must not load remote url()`);
  }
}

export function parseThemeVars(css) {
  const block = css.match(/:root\s*\{([^}]+)\}/);
  if (!block) throw new Error("theme file needs a :root block");
  const names = [...block[1].matchAll(/--([a-z0-9-]+)\s*:/gi)].map((m) => `--${m[1]}`);
  return names;
}

export function assertThemeOnlyOverrides(rel, css) {
  const names = parseThemeVars(css);
  const extra = names.filter((n) => !THEME_OVERRIDE_VARS.includes(n));
  if (extra.length) throw new Error(`${rel} may only override ${THEME_OVERRIDE_VARS.join(", ")}; found ${extra.join(", ")}`);
  for (const need of THEME_OVERRIDE_VARS) {
    if (!names.includes(need)) throw new Error(`${rel} missing ${need}`);
  }
}

export function packKit({
  sourceRoot = DESIGN_SYSTEM_ROOT,
  destRoots = null,
  snapshot = true,
} = {}) {
  const version = readVersion(sourceRoot);
  const files = kitSourceFiles(sourceRoot);
  const packed = {};
  for (const [rel, src] of files) {
    const text = readFileSync(src, "utf8");
    if (rel.endsWith(".css")) assertOfflineCss(rel, text);
    if (rel.startsWith("themes/")) assertThemeOnlyOverrides(rel, text);
    packed[rel] = text;
  }

  const roots = destRoots || [path.join(sourceRoot, "dist", `jibby-kit-${version}`)];
  if (!destRoots && snapshot) {
    roots.push(path.join(REPO_ROOT, "v3", "public", "kit"));
    roots.push(path.join(REPO_ROOT, "ops", "public", "kit"));
  }

  for (const root of roots) {
    if (root.includes(`${path.sep}dist${path.sep}`) || root.endsWith(`${path.sep}dist`)) {
      rmSync(path.dirname(root), { recursive: true, force: true });
    }
    mkdirSync(path.join(root, "themes"), { recursive: true });
    for (const [rel, text] of Object.entries(packed)) {
      const dest = path.join(root, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, text);
    }
  }

  return { version, files: Object.keys(packed), destRoots: roots };
}

const launchedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (launchedDirectly) {
  const result = packKit();
  process.stdout.write(`packed jibby-kit-${result.version}\n`);
}
