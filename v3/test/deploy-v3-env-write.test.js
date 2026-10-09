// deploy-v3.yml 對 web-a／web-b 的 .env 寫入改「單鍵寫入」的離線自測（2026-10-09）。
//
// 背景：舊寫法用 `printf 'V3_IMAGE=…' > .env` 整份覆寫，開閘後若再發版會把
// PG_NO_SQLITE_OPEN=1 靜默洗掉。改成與 591-tracker-v3 的 V3_IMAGE_PIN 同一種「單鍵寫入」
// （cp -p 備份 → 有鍵 sed 覆值／無鍵 append → chmod 還原 mode → grep -c=1 → 值比對）。
//
// 這裡**不碰任何 NAS**：只做三件事——
//   1. 斷言 YAML 已不再是整份覆寫（`> .env` 消失、單鍵寫入的 sed/append/stat/cp -p 出現）。
//   2. `bash -n` 語法檢查 A／B 兩段 script 區塊（把 GitHub Actions 佔位符換成假值）。
//   3. 用暫存假 .env 跑同一套單鍵寫入邏輯**兩次**，斷言「第二個鍵不變、值不變、V3_IMAGE 只有一行」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = join(repoRoot, ".github", "workflows", "deploy-v3.yml");
const yaml = readFileSync(workflowPath, "utf8");

// 把 YAML 裡 `script: |` 的區塊全部抽出來。
function extractScriptBlocks(text) {
  const blocks = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*script:\s*\|\s*$/.test(lines[i])) continue;
    const indent = lines[i].match(/^\s*/)[0].length;
    const block = [];
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (line.trim() === "") { block.push(line); j += 1; continue; }
      const lineIndent = line.match(/^\s*/)[0].length;
      if (lineIndent <= indent) break;
      block.push(line);
      j += 1;
    }
    blocks.push(block.join("\n"));
    i = j - 1;
  }
  return blocks;
}

// 把 GitHub Actions 的 ${{ … }} 佔位符換成假值，讓 bash -n 能吃下去。
function deTemplated(block) {
  return block
    .replace(/\$\{\{\s*inputs\.image_digest\s*\}\}/g, "0000000000000000000000000000000000000000000000000000000000000000")
    .replace(/\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}/g, "dummy")
    .replace(/\$\{\{\s*steps\.[A-Za-z0-9_.-]+\s*\}\}/g, "dummy");
}

test("deploy-v3 的 A／B 組 .env 不再整份覆寫，而是單鍵寫入", () => {
  // 整份覆寫的舊寫法必須消失（`> .env` 那兩行）。
  assert.ok(!yaml.includes("printf 'V3_IMAGE=%s\\n' \"$IMAGE_PIN\" > \"$A_DIR/.env\""), "A 組不得整份覆寫 .env");
  assert.ok(!yaml.includes("printf 'V3_IMAGE=%s\\n' \"$IMAGE_PIN\" > \"$B_DIR/.env\""), "B 組不得整份覆寫 .env");
  // A、B 兩段都要有 cp -p 備份、sed 覆值、append、stat 記 mode、chmod 還原、grep -c=1、值比對。
  for (const P of ["A", "B"]) {
    const checks = [
      `${P}_ENV="$${P}_DIR/.env"`,
      `cp -p "$${P}_ENV" "$${P}_ENV.bak"`,
      `${P}_MODE="$(stat -c '%a' "$${P}_ENV")"`,
      `sed -i "s|^V3_IMAGE=.*|V3_IMAGE=\${IMAGE_PIN}|" "$${P}_ENV"`,
      `printf 'V3_IMAGE=%s\\n' "$IMAGE_PIN" >> "$${P}_ENV"`,
      `chmod "$${P}_MODE" "$${P}_ENV"`,
      `grep -c '^V3_IMAGE=' "$${P}_ENV"`,
      `grep -Fqx "V3_IMAGE=\${IMAGE_PIN}" "$${P}_ENV"`,
    ];
    for (const c of checks) assert.ok(yaml.includes(c), `${P} 組應包含：${c}`);
  }
});

test("A／B 兩段 script 區塊 bash -n 語法檢查通過", () => {
  const blocks = extractScriptBlocks(yaml);
  assert.ok(blocks.length >= 3, `應抽出至少 3 段 script（實際 ${blocks.length}）`);
  for (let i = 0; i < blocks.length; i += 1) {
    const r = spawnSync("bash", ["-n"], {
      input: deTemplated(blocks[i]),
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `script 區塊 #${i} bash -n 失敗：${r.stderr}`);
  }
});

// 抽出 A 組 script 裡「單鍵寫入」那 8 行，把變數名換成獨立變數後回傳可執行腳本。
function singleKeyWriteScript(envFile, imagePin) {
  const block = extractScriptBlocks(yaml)
    .map(deTemplated)
    .find((b) => b.includes('A_ENV="$A_DIR/.env"'));
  assert.ok(block, "找不到 A 組 script 區塊");
  const lines = block.split("\n");
  const start = lines.findIndex((l) => l.includes('A_ENV="$A_DIR/.env"'));
  const end = lines.findIndex((l) => l.includes('grep -Fqx "V3_IMAGE=${IMAGE_PIN}"'));
  assert.ok(start >= 0 && end >= start, "找不到單鍵寫入的起訖行");

  let body = lines.slice(start, end + 1).join("\n");
  // 1. ENV_FILE 指向假 .env。
  body = body.replace('A_ENV="$A_DIR/.env"', `ENV_FILE="${envFile}"`);
  // 2. 其餘 $A_ENV 全部指到 ENV_FILE。
  body = body.replace(/\$A_ENV/g, "$ENV_FILE");
  // 3. A_MODE → MODE。
  body = body.replace(/\bA_MODE\b/g, "MODE");
  return `set -euo pipefail\nIMAGE_PIN="${imagePin}"\n${body}`;
}

test("單鍵寫入跑兩次：第二個鍵不變、值不變、V3_IMAGE 只有一行", () => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-env-"));
  const envFile = join(dir, ".env");
  try {
    writeFileSync(envFile, "V3_IMAGE=ghcr.io/fyun48/5151@old\nPG_NO_SQLITE_OPEN=1\nSESSION_SECRET=keep-me\n");
    const pin1 = "ghcr.io/fyun48/5151@sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const pin2 = "ghcr.io/fyun48/5151@sha256:2222222222222222222222222222222222222222222222222222222222222222";

    for (const pin of [pin1, pin2]) {
      const script = singleKeyWriteScript(envFile, pin);
      const syntax = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
      assert.equal(syntax.status, 0, `單鍵寫入腳本 bash -n 失敗：${syntax.stderr}`);
      const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
      assert.equal(r.status, 0, `單鍵寫入非零退出：${r.stdout}\n${r.stderr}`);
    }

    const after = readFileSync(envFile, "utf8");
    // 第二個鍵（PG_NO_SQLITE_OPEN、SESSION_SECRET）原值不變。
    assert.match(after, /^PG_NO_SQLITE_OPEN=1$/m, "PG_NO_SQLITE_OPEN 不得被洗掉");
    assert.match(after, /^SESSION_SECRET=keep-me$/m, "SESSION_SECRET 不得被洗掉");
    // V3_IMAGE 恰好一行，且是最後一次寫入的 pin2。
    const v3 = after.split("\n").filter((l) => l.startsWith("V3_IMAGE="));
    assert.equal(v3.length, 1, `V3_IMAGE 必須只有一行（實際 ${v3.length}）`);
    assert.equal(v3[0], `V3_IMAGE=${pin2}`, "V3_IMAGE 必須被覆寫成最後一次的值");
    // 備份檔存在（cp -p）。
    assert.ok(existsSync(`${envFile}.bak`), "應留下 .env.bak 備份");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
