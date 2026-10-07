import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
  assert.match(ops, /image:\s*"?\$\{OPS_RUNTIME_IMAGE:\?[^)]*\}"?/);
  assert.doesNotMatch(ops, /image:\s*"?ghcr\.io\/fyun48\/5151:latest"?/);
});

test("compose 檔必須能真的解析（regex 抓不到的 YAML 錯誤曾当场停掉 OPS）", () => {
  // 2026-10-07：`${VAR:?message}` 的 message 含「冒號＋空格」→ YAML 當成巢狀 mapping，
  // 而腳本已在 `docker rm -f` 之後才炸，OPS 直接停機。所以尺規要真的 parse，不只是字串比對。
  const parsed = JSON.parse(
    execFileSync("python3", ["-c", "import sys,yaml,json;print(json.dumps(yaml.safe_load(sys.stdin.read())))"], {
      input: compose, encoding: "utf8",
    })
  );
  const svc = parsed.services["5151-ops"];
  assert.equal(svc.container_name, "5151-ops");
  assert.match(svc.image, /\$\{OPS_RUNTIME_IMAGE:\?/);
  assert.deepEqual(svc.ports, ["127.0.0.1:5154:5154"]);
  assert.equal(svc.environment.PRODUCTION_RELEASE_ALLOW_LIVE, "0");
  assert.equal(parsed.services["ops-cloudflared"].network_mode, "host");
  assert.equal(parsed.services["ops-cloudflared"].environment.TUNNEL_TOKEN_FILE, "/run/secrets/ops-tunnel-token");
});

test("寫 .env 要帶鍵名，source 前要過濾成 KEY=VALUE 行", () => {
  // 2026-10-07 實測：舊版把整行只寫 digest 的 .env 直接 source，shell 拿它當指令執行
  // → 「No such file or directory」，腳本在碰任何容器之前就中止（所幸 fail-closed，OPS 沒被打掉）。
  const code = script.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.match(code, /printf 'OPS_RUNTIME_IMAGE=%s\\n'/);
  assert.match(code, /grep -E '\^\[A-Za-z_\]\[A-Za-z0-9_\]\*='/);
  assert.doesNotMatch(code, /^printf '%s\\n' "\$OPS_RUNTIME_IMAGE" > "\$ENV_FILE\.tmp"/m);
});

test("token 檔必須交給容器 uid（cloudflared 影像跑 65532，root:600 它讀不到）", () => {
  // 2026-10-07 實測： chmod 600 留給 root 擁有 → 容器 Up 但日誌一直
  // 「Failed to read token file: permission denied」，tunnel 永遠 inactive。
  const code = script.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.match(code, /chown "\$\{OPS_TUNNEL_UID:-65532\}:\$\{OPS_TUNNEL_GID:-65532\}" "\$SECRET_DIR" "\$TOKEN_FILE"/);
  assert.match(code, /chmod 400 "\$TOKEN_FILE"/);
  assert.match(code, /chmod 700 "\$SECRET_DIR"/);
});

test("要驗 tunnel 真的註冊，不能只看容器 running", () => {
  // 「容器 Up」不等於「對外通道可用」：token 讀不到時照樣 Up，hostname 搬過去只會 530。
  const code = script.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
  // ① 字串要對：官方日誌是 "Registered tunnel connection"
  // ② 不能用窄時間窗：容器沒被重建時 `--since 90s` 必然為空 → 誤判發版失敗
  // ③ 要看「最後一條事件」而不是「歷史有沒有」：否則先成功、後來壞會被掩蓋
  assert.match(code, /grep -E "Registered tunnel connection\|Failed to read token file" \| tail -1/);
  // ④ bash 的 case pattern 是「錨定全字串」：少尾 * 就變成「必須以它結尾」。
  //    真日誌那行後面還有 ` connIndex=…`，所以少了尾 * 會永遠不匹配（我踩過，被自己的檢查誤殺）。
  assert.match(code, /\*"Registered tunnel connection"\*\) log /);
  assert.doesNotMatch(code, /\*"Registered tunnel connection"\) /);
  assert.match(code, /\*\) fail "cloudflared 最後一條事件不是註冊成功/);
  assert.doesNotMatch(code, /Registered a new connection/);
  assert.doesNotMatch(code, /docker logs --since \d+s 5151-ops-cloudflared/);
});

test("發版腳本要先解析 compose，才准摘除現有容器", () => {
  const code = script.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
  const configAt = code.indexOf("config -q");
  const rmAt = code.indexOf("docker rm -f 5151-ops");
  assert.ok(configAt > -1, "缺少 compose config -q 事前驗證");
  assert.ok(rmAt > -1, "找不到摘除容器的步驟");
  assert.ok(configAt < rmAt, "順序錯了：必須先 config -q 再 docker rm -f");
  assert.match(code, /尚未摘除任何容器/);
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

test("生效中的規則檔 .cursor/rules/infra-access.mdc 也要有 OPS 例外與掛檔禁令（不得只改 AGENTS.md）", () => {
  // 這份是 Cursor 每次會讀的規則檔；若只有 AGENTS.md 改了、這裡還寫舊域名／舊做法，
  // 下一个 agent 會照舊規則把 OPS 塞回吉比的 tunnel（本次稽核就發現它殘留 jibbyrentops）。
  const mdc = readFileSync(path.join(ROOT, ".cursor/rules/infra-access.mdc"), "utf8");
  assert.match(mdc, /產品站不要另開 tunnel/);
  assert.match(mdc, /ops\.reversalplay\.me/);
  assert.match(mdc, /TUNNEL_TOKEN_FILE/);
  assert.doesNotMatch(mdc, /jibbyrentops/);
});

test("吉比的兩份 app 定義都不准再出現 OPS 服務（拆乾淨才算隔離）", () => {
  // docker-compose.yml 給 workflow、casaos-compose.yml 給 CasaOS 介面的「重新部署」；
  // 兩邊留著 5151-ops 都會在整 project up 時與獨立 project 撞 container_name，
  // 或更糟：把 OPS 打回 :latest ＋ 宿主未追蹤的 ./ops。
  const v3Compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
  const casaos = readFileSync(path.join(ROOT, "casaos-compose.yml"), "utf8");
  for (const [name, text] of [["docker-compose.yml", v3Compose], ["casaos-compose.yml", casaos]]) {
    assert.doesNotMatch(text, /^ {2}5151-ops:/m, `${name} 不應定義 5151-ops`);
    assert.doesNotMatch(text, /5154/, `${name} 不應出現 OPS 埠 5154`);
  }
});
