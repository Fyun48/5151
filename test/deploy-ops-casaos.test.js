import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// OPS CasaOS 發版材料的尺規（Owner 指示 2026-10-07：OPS 須與單一專案的故障隔開）。
// 意圖很窄：不準浮動映像、不準把 tunnel token 寫進 argv、不準再出現「没人知道怎麼重建」的來源。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = readFileSync(path.join(ROOT, "docker-compose.ops.casaos.yml"), "utf8");
const script = readFileSync(path.join(ROOT, "ops/scripts/deploy-ops-casaos.sh"), "utf8");
const agents = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");

function service(src, name) {
  const start = src.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `compose 缺少 service ${name}`);
  const rest = src.slice(start + 2);
  const m = rest.match(/\r?\n  [a-zA-Z0-9_-]+:/);
  return m ? src.slice(start, start + 2 + m.index) : src.slice(start);
}

test("ops service 一律由 env 釘 digest，不准 :latest", () => {
  const ops = service(compose, "5151-ops");
  assert.match(ops, /image: \$\{OPS_RUNTIME_IMAGE:\?[^)]*\}/);
  assert.doesNotMatch(ops, /image:\s*ghcr\.io\/fyun48\/5151:latest/);
});

test("ops 原始碼走 releases/<SHA> 的 current symlink，不再是相對目錄手動複製", () => {
  const ops = service(compose, "5151-ops");
  assert.match(ops, /current\/ops:\/app\/ops:ro/);
  assert.doesNotMatch(ops, /-\s+\.\/ops:\/app\/ops:ro/);
});

test("只綁宿主 loopback，資料目錄可覆寫但預設維持原地", () => {
  const ops = service(compose, "5151-ops");
  assert.match(ops, /"127\.0\.0\.1:5154:5154"/);
  assert.doesNotMatch(ops, /"5154:5154"/);
  assert.match(ops, /\$\{OPS_CASAOS_DATA_ROOT:-\/DATA\/AppData\/5151-ops\}:\/data/);
});

test("Production release live mutation 預設關閉（與 synology 版一致）", () => {
  assert.match(service(compose, "5151-ops"), /PRODUCTION_RELEASE_ALLOW_LIVE: "0"/);
});

test("OPS tunnel 走自己的服務，token 用掛檔而不是 command line", () => {
  const t = service(compose, "ops-cloudflared");
  assert.match(t, /container_name: 5151-ops-cloudflared/);
  assert.match(t, /TUNNEL_TOKEN_FILE: \/run\/secrets\/ops-tunnel-token/);
  assert.match(t, /network_mode: host/); // 127.0.0.1:5154 是宿主的 loopback
  assert.doesNotMatch(t, /--token/);
  assert.doesNotMatch(compose, /^\s*command:.*--token/m);
});

test("發版腳本 fail-closed，並拒絕浮動映像與壞健康檢查寫法", () => {
  // 只驗 executable 行：腳本的註解裡寫著「不要用 `|| echo 000`」這類反例說明，不該被判違規。
  const code = script.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.match(code, /set -euo pipefail/);
  assert.match(code, /trap rollback EXIT/);
  // L-0131：不准 `-f`，也不准 `|| echo 000`（會得到 000000 永判健康）
  assert.doesNotMatch(code, /curl [^|]* -f( |")/);
  assert.doesNotMatch(code, /\|\|\s*echo 000/);
  assert.match(code, /--max-time 6 "\$HEALTH_URL" 2>\/dev\/null \|\| true/);
  assert.match(code, /\[ "\$code" = "200" \] \|\| fail/);
  assert.match(code, /:latest 一律拒絕/);
  // 驗明容器內跑的碼就是該 SHA，避免「切了 symlink 但其實還在跑舊檔」
  assert.match(code, /md5sum \/app\/ops\/src\/server\.js/);
});

test("腳本只碰 OPS，不碰吉比的服務", () => {
  for (const forbidden of ["591-tracker-v3", "5151-web-A", "deploy-v3"]) {
    assert.ok(!script.includes(forbidden), `腳本不應出現 ${forbidden}`);
  }
});

test("AGENTS.md 已為 OPS 控制面留下 tunnel 例外（不得被無聲改回）", () => {
  assert.match(agents, /OPS 控制面.*自己的 tunnel|OPS.*獨立 tunnel/);
  assert.match(agents, /ops\.reversalplay\.me/);
  assert.doesNotMatch(agents, /jibbyrentops/);
});
