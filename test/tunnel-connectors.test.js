import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 吉比四台 Cloudflare connector 的定義尺規（2026-10-07 token 外流事件後立的規則）。
// 意圖很窄：token 不准再進 argv、映像不准浮動、來源不准是「沒人知道怎麼重建」的 docker run。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CF = "deploy/shadow-ha/cloudflared";

const CONNECTORS = {
  "docker-compose.yml#cloudflared（casa／公開站）": [path.join(ROOT, "docker-compose.yml"), "cloudflared"],
  "docker-compose.public-b.yml（syn／公開站）": [path.join(ROOT, CF, "docker-compose.public-b.yml"), "591-tracker-tunnel-b"],
  "docker-compose.shadow-a.yml（casa／shadow）": [path.join(ROOT, CF, "docker-compose.shadow-a.yml"), "5151-cloudflared-A"],
  "docker-compose.shadow-b.yml（syn／shadow）": [path.join(ROOT, CF, "docker-compose.shadow-b.yml"), "5151-cloudflared-B"],
};

function blockOf(file, service) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${service}:`);
  assert.ok(start >= 0, `找不到 service ${service}（${file}）`);
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^ {0,2}\S/.test(l) && !/^\s*#/.test(l)) break;
    out.push(l);
  }
  return out.join("\n");
}

for (const [label, [file, service]] of Object.entries(CONNECTORS)) {
  test(`${label}：token 不進 argv、映像釘 digest、掛檔唯讀`, () => {
    const b = blockOf(file, service);
    // ① 這條是本次事件的主因：argv 裡的 token 任何有 docker 權限的身分都讀得到
    assert.doesNotMatch(b, /--token/, "不准把 tunnel token 寫進 command line");
    assert.doesNotMatch(b, /\$\{TUNNEL_TOKEN\b/, "不准再用 TUNNEL_TOKEN 插值進 argv");
    assert.match(b, /TUNNEL_TOKEN_FILE:\s*\/run\/secrets\/token/, "要用掛檔＋TUNNEL_TOKEN_FILE");
    // ② 掛載必須唯讀，且指向 secrets 目錄（不是整個 app 目錄）
    assert.match(b, /volumes:\n\s*- \S*secrets\S*:\/run\/secrets:ro/, "secrets 要以 :ro 掛進 /run/secrets");
    // ③ 映像要釘 digest（:latest 會讓重建時的版本不可控）
    assert.match(b, /image: cloudflare\/cloudflared@sha256:[0-9a-f]{64}/, "connector 映像要釘 digest");
    assert.doesNotMatch(b, /image: cloudflare\/cloudflared:latest/);
    // ④ 這四台都必須是 compose 管理的（不能回到 docker run 孤兒）
    assert.match(b, /container_name: /);
    assert.match(b, /network_mode: host/);
  });
}

test("四份 connector 定義都要能被 YAML 真的解析（正則全綠也可能上線就炸）", () => {
  for (const [, [file]] of Object.entries(CONNECTORS)) {
    const out = execFileSync("python3", ["-c", "import sys,yaml,json;print(json.dumps(sorted((yaml.safe_load(sys.stdin.read()) or {}).get('services') or [])))"], {
      input: readFileSync(file), encoding: "utf8",
    });
    assert.ok(JSON.parse(out).length >= 1, `${file} 解析後沒有 services`);
  }
});

test("生效中的文件不能還指著已刪除的舊 tunnel", () => {
  // 舊 `5151`／`5151-shadow-web` 已因 token 外流刪除；文件若還寫舊 id，下一位會去接一條不存在的 tunnel。
  // 交接檔（docs/handoffs/）是歷史紀錄，允許出現舊 id，所以只掃「現況文件」。
  const live = [
    path.join(ROOT, CF, "README.md"),
    path.join(ROOT, "docs", "runbooks", "shared-infra-access.md"),
    path.join(ROOT, "deploy", "shadow-ha", "web", "README.md"),
    path.join(ROOT, "AGENTS.md"),
  ];
  for (const f of live) {
    const t = readFileSync(f, "utf8");
    assert.doesNotMatch(t, /3adb90bf|4c70b226/, `${path.relative(ROOT, f)} 還引用已刪除的舊 tunnel id`);
  }
  for (const f of live.slice(0, 3)) {
    assert.match(readFileSync(f, "utf8"), /5151-b|f36d61e6/, `${path.relative(ROOT, f)} 沒寫新 tunnel`);
  }
});

test("替換 tunnel 的零中斷順序要寫進 runbook（下次照做，不要再混合 200／530）", () => {
  const rb = readFileSync(path.join(ROOT, "docs", "runbooks", "shared-infra-access.md"), "utf8");
  assert.match(rb, /過渡 connector/);
  assert.match(rb, /dns_records|CNAME/);
  assert.match(rb, /刪除舊 tunnel|刪除舊/);
  // 目錄也要能進：只 chown 檔會 Failed to read token file（我踩過兩次）
  assert.match(rb, /目錄也要能進|目錄 700/);
});

test("交接檔 §6：其他專案 12 台的來源都要有交代（三台孤兒要已補重建檔）", () => {
  const t = readFileSync(path.join(ROOT, "docs/handoffs/20261007-tunnel-token-rotation.md"), "utf8");
  assert.match(t, /argv 9 台／env 3 台/, "要寫明確數（argv／env 分开算）");
  for (const p of [
    "/mnt/Storage1/docker/cf-ssh-casa/docker-compose.yml",
    "/var/services/homes/tori/rebuild/cf-ssh-tori/docker-compose.yml",
    "/var/services/homes/tori/rebuild/jgitea-tunnel/docker-compose.yml",
  ]) {
    assert.ok(t.includes(p), `孤兒 ${p} 沒在文件裡標出重建來源`);
  }
  assert.match(t, /不在這次授權內|該案 Production/, "要寫明改造別人專案需逐案核准");
});


// 這條檢查的是「本機憑證庫」而非 repo 內容，所以在沒有憑證庫的環境（CI／新 clone）自動跳過，
// 但在這台機器上它是真的會紅——拿到新憑證沒更新 INDEX 就違反作業規則一.3。
const SECRETS_INDEX = process.env.SECRETS_INDEX || "/home/cline/.secrets/INDEX.md";
test("憑證索引要收錄兩把新 tunnel token（值不入檔）", { skip: existsSync(SECRETS_INDEX) ? false : `找不到 ${SECRETS_INDEX}` }, () => {
  const idx = readFileSync(SECRETS_INDEX, "utf8");
  assert.match(idx, /tunnel-5151-token\.txt/);
  assert.match(idx, /tunnel-5151-shadow-web-token\.txt/);
  assert.match(idx, /值不記錄|值不寫|不記錄於本檔/);
});
