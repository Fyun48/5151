import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

// v3 → OPS feedback 交付的「設定形状」尺規（2026-10-07）。
// 存在的理由：這條路要「三把鑰匙成對＋只由 worker/all 角色啟動」才有效，
// 兩处踩錯都會**靜默失效**（交付沒跑、或 OPS 開機 throw），所以用測試釘住。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const DELIVERY_KEYS = ["OPS_FEEDBACK_DELIVERY", "OPS_INGEST_URL", "OPS_INGEST_SECRET"];

// ① repo 只能出現「插值＋安全預設」，不准有硬編碼值（F-0003）
for (const f of ["docker-compose.yml", "deploy/shadow-ha/web/web-b/docker-compose.yml"]) {
  test(`${f}：交付鍵走插值且預設為關`, () => {
    const t = read(f);
    for (const k of DELIVERY_KEYS) {
      assert.match(t, new RegExp(`${k}: \\$\\{${k}:-0?\\}`), `${f} 的 ${k} 要用 \${${k}:-…} 插值`);
    }
    assert.match(t, /OPS_FEEDBACK_DELIVERY: \$\{OPS_FEEDBACK_DELIVERY:-0\}/, "預設必須是 0（關）");
    assert.match(t, /OPS_INGEST_URL: \$\{OPS_INGEST_URL:-\}/, "URL 預設必須是空");
    assert.doesNotMatch(t, /OPS_(INGEST_SECRET|FEEDBACK_DELIVERY):\s*["']?[0-9a-f]{24,}/, "不准把憑證值寫進 repo");
  });
}

// ② OPS 兩份 compose：成對的兩把都要有，且預設空（沒有值就不 seed、不炸）
for (const f of ["docker-compose.ops.casaos.yml", "docker-compose.ops.synology.yml"]) {
  test(`${f}：INGEST_SECRET 與 AT_REST_KEY 成對出現`, () => {
    const t = read(f);
    assert.match(t, /OPS_INGEST_SECRET: "\$\{OPS_INGEST_SECRET:-\}"/, f + " 缺 OPS_INGEST_SECRET 插值");
    assert.match(t, /OPS_SECRET_AT_REST_KEY: "\$\{OPS_SECRET_AT_REST_KEY:-\}"/, f + " 缺 OPS_SECRET_AT_REST_KEY 插值");
    assert.doesNotMatch(t, /OPS_(INGEST_SECRET|SECRET_AT_REST_KEY):\s*["']?[0-9a-f]{32,}/, "不准把值寫進 repo");
  });
}

// ③ 發版腳本要在「動 current／容器之前」攔下只給一把的情境（否則 OPS 開機 throw）
test("deploy-ops-casaos.sh：成對攔截＋金鑰形狀檢查在摘容器之前", () => {
  const t = read("ops/scripts/deploy-ops-casaos.sh");
  assert.match(t, /設了 OPS_INGEST_SECRET 但缺 OPS_SECRET_AT_REST_KEY/, "缺成對攔截");
  assert.match(t, /OPS_SECRET_AT_REST_KEY 形狀不對/, "缺金鑰形狀檢查");
  const guardAt = t.indexOf("設了 OPS_INGEST_SECRET 但缺 OPS_SECRET_AT_REST_KEY");
  const flipAt = t.indexOf("flip_current");
  assert.ok(guardAt > 0 && (flipAt < 0 || guardAt < flipAt), "攔截要排在切換 current 之前");
  assert.ok(t.includes("config -q"), "仍要先 compose config -q 才准摘容器（既有規則）");
});

// ④ 角色語意：交付只能由 worker/all 啟動 —— 代碼若改到 web 角色也要同步改這裡的說明
test("遞送迴圈確實掛在 worker 角色（說明文字不得過度承諾）", () => {
  const server = read("v3/src/server.js");
  const fn = server.slice(server.indexOf("function startWorkerLoops()"), server.indexOf("function startWorkerLoops()") + 1400);
  assert.match(fn, /deliveryConfigFromEnv\(\)/, "startWorkerLoops 內要能看到遞送啟動");
  const role = read("v3/src/appRole.js");
  assert.match(role, /roleRunsWorker\(role\)[\s\S]*?worker"\s|\|\| role === "all"/, "roleRunsWorker 要認 worker／all");
  const webA = read("deploy/shadow-ha/web/web-a/docker-compose.yml");
  assert.doesNotMatch(webA, /OPS_FEEDBACK_DELIVERY/, "web 角色的 service 不該出現交付鍵（設了也不跑，會誤導）");
  const compose = read("docker-compose.yml");
  assert.match(compose.slice(compose.indexOf("  591-tracker-v3:"), compose.indexOf("  cloudflared:")), /未設 APP_ROLE|all/, "要註明本服務是 all 角色＝現行實際的 worker");
});

// ⑤ OPS 的對外通道也不准被 :latest 牽動（與 runtime 同一條原則）
test("OPS compose／發版腳本：tunnel 映像預設釘 digest 且拒 :latest", () => {
  const compose = read("docker-compose.ops.casaos.yml");
  assert.doesNotMatch(compose, /OPS_TUNNEL_IMAGE:-cloudflare\/cloudflared:latest/, "預設不能是 :latest");
  assert.match(compose, /OPS_TUNNEL_IMAGE:-cloudflare\/cloudflared@sha256:[0-9a-f]{64}/, "預設要釘 digest");
  const script = read("ops/scripts/deploy-ops-casaos.sh");
  assert.match(script, /OPS_TUNNEL_IMAGE 必須釘 digest/, "腳本缺 tunnel 映像檢查");
  assert.doesNotMatch(script, /OPS_TUNNEL_IMAGE:-cloudflare\/cloudflared:latest/, "腳本不該把預設放成 :latest");
});
