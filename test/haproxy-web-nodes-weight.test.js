import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// HAProxy `backend web_nodes` 加權的守護測試（2026-10-12）。
//
// 為什麼要有這條：`deploy/shadow-ha/haproxy/haproxy.cfg` 是**權威來源**，但它不會被 CI 執行，
// 改壞了也只有「planner 手動 reload 到正式機」那一刻才會發現；而把 `weight` 拿掉（或被整段覆蓋成
// 50/50）是**靜默**的——語法照樣合法、兩台照樣 UP，只是新進流量又平均落回慢的那台
// （2026-10-12 實測端對端中位：web-B 3,915ms vs web-A 5,240ms，差 25%）。
//
// 這是**離線**靜態檢查（只讀檔，不連任何主機、不起容器）。比對邏輯放成吃字串的 `checkWebWeights()`，
// 下面用「刻意改壞」的 mutant 證明它真的會紅（見最後一個 test）。

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CFG = "deploy/shadow-ha/haproxy/haproxy.cfg";
const cfgPath = path.join(root, CFG);

// 取出 `backend <name>` 到下一個 backend 之間的內容（不含註解行留著也無妨，這裡只比對非註解行）。
function backendBlock(cfg, name) {
  const start = cfg.search(new RegExp(`^backend\\s+${name}\\s*$`, "m"));
  assert.notEqual(start, -1, `${CFG}: missing backend ${name}`);
  const rest = cfg.slice(start);
  const next = rest.slice(1).search(/^backend\s/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function isComment(line) {
  return /^\s*#/.test(line);
}

// server 行以空白分隔；weight 是後面帶值的關鍵字，所以要往後看一格。
export function checkWebWeights(cfg) {
  const block = backendBlock(cfg, "web_nodes");

  // 註解行留著也無妨，這裡只比對非註解行。
  const lines = block
    .split("\n")
    .filter((l) => l.trim() && !isComment(l));

  const servers = lines.filter((l) => /^\s*server\s/.test(l));
  const problems = [];

  if (servers.length !== 2) {
    problems.push(`${CFG} backend web_nodes: expected 2 server lines, found ${servers.length}`);
  }

  const expected = { "web-a": null, "web-b": null };
  for (const line of servers) {
    const name = (line.match(/^\s*server\s+(\S+)/) || [])[1];
    const w = line.match(/(?:^|\s)weight\s+(\S+)/);
    if (!(name in expected)) {
      problems.push(`${CFG} backend web_nodes: unexpected server "${name}" (expected web-a / web-b)`);
      continue;
    }
    const raw = w ? w[1] : null;
    expected[name] = raw;
    if (raw === null) {
      problems.push(`${CFG} backend web_nodes server ${name}: no explicit "weight <n>"`);
      continue;
    }
    if (!/^\d+$/.test(raw)) {
      problems.push(`${CFG} backend web_nodes server ${name}: weight "${raw}" is not an integer`);
      continue;
    }
    const v = Number(raw);
    if (v < 1) {
      problems.push(`${CFG} backend web_nodes server ${name}: weight ${v} (0 = never receives new connections)`);
    }
    if (v > 256) {
      problems.push(`${CFG} backend web_nodes server ${name}: weight ${v} exceeds HAProxy max 256`);
    }
  }

  // 兩台的相對權重是這次改動的重點：web-B（syn-nas，32GB）要吃得比 web-A（casa-nas，4 核）多。
  if (expected["web-a"] !== null && expected["web-b"] !== null) {
    const a = Number(expected["web-a"]);
    const b = Number(expected["web-b"]);
    if (Number.isFinite(a) && Number.isFinite(b) && !(b > a)) {
      problems.push(`${CFG} backend web_nodes: web-b weight (${b}) must exceed web-a weight (${a})`);
    }
  }

  if (problems.length) return { ok: false, problems, weights: expected };
  return { ok: true, problems: [], weights: expected };
}

test("haproxy.cfg web_nodes: web-a weight 30 / web-b weight 70（新黏滯流量偏快節點）", () => {
  const cfg = readFileSync(cfgPath, "utf8");
  const r = checkWebWeights(cfg);
  assert.deepEqual(r.problems, [], r.problems.join("\n"));
  assert.deepEqual(r.weights, { "web-a": "30", "web-b": "70" });
});

test("haproxy.cfg web_nodes: 既有健康檢查與 redispatch/retry-on 不得被覆蓋", () => {
  const cfg = readFileSync(cfgPath, "utf8");
  const block = backendBlock(cfg, "web_nodes");
  // 這兩條是 2026-09-23 演練的成果（節點中途死掉回 503 的處置），加權不該動到它們。
  assert.match(block, /option redispatch/);
  assert.match(block, /retry-on conn-failure empty-response response-timeout/);
  assert.match(block, /option httpchk GET \/api\/health/);
  assert.match(block, /http-check expect status 200/);
  // 2026-10-10 Owner 核准的訪客黏滯：加權只影響「新」黏滯的分配，這兩行必須留著。
  assert.match(block, /stick-table type string len 45 size 100k expire 30m/);
  assert.match(block, /stick on req\.hdr\(cf-connecting-ip\) if \{ req\.hdr\(cf-connecting-ip\) -m found \}/);
  // 加權是 web backend 專屬；PG 的 pgsql-check backend 不准出現 weight（會改變寫入路由語意）。
  assert.doesNotMatch(cfg, /^\s*server\s+pg-a\s.*weight\s/m);
  assert.doesNotMatch(cfg, /^\s*server\s+pg-b\s.*weight\s/m);
});

test("haproxy.cfg 不得殘留 ${...} 佔位符：本檔已是實體 IP（2026-10-12 起不是 template）", () => {
  const raw = readFileSync(cfgPath, "utf8");
  // 2026-10-12 實查後改正：正式機的容器是把這份 cfg **單檔 bind mount** 進
  // /usr/local/etc/haproxy/haproxy.cfg（`-f` 直接指它），**沒有** render-and-run.sh 那一層。
  // 所以這裡不再模擬 sed 展開，而是直接要求檔內不得出現 ${...}——
  // 一旦殘留，就代表有人把舊的 template 版檔案放回來（HAProxy 會把 ${CASAOS_HOST} 當主機名）。
  const leftovers = raw
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => !isComment(line) && line.includes("${"));
  assert.deepEqual(leftovers, [], `未預期的 \${...} 佔位符（本檔應為實體 IP）：${JSON.stringify(leftovers)}`);
  // 兩個 server 行都要是實體 IP。
  const block = backendBlock(raw, "web_nodes");
  assert.match(block, /^\s*server web-a 192\.168\.0\.140:15153 .*weight 30$/m);
  assert.match(block, /^\s*server web-b 192\.168\.0\.220:15153 .*weight 70$/m);
});

test("haproxy.cfg PG 路由：pg_rw→pg_primary、pg_ro→pg_standby_first；pg_primary 用 agent-check 且 pg-b 不帶 backup", () => {
  const cfg = readFileSync(cfgPath, "utf8");
  // 「寫入只能到 primary」是本專案最硬的約束——前端到 backend 的對應不准被改錯。
  assert.match(cfg, /^frontend pg_rw\n\s+bind \*:25433\n\s+default_backend pg_primary$/m);
  assert.match(cfg, /^frontend pg_ro\n\s+bind \*:25434\n\s+default_backend pg_standby_first$/m);
  const primary = backendBlock(cfg, "pg_primary");
  // 角色由 agent-check 判定（2026-10-09 實上線、2026-10-12 同步回本檔）。
  assert.match(primary, /^\s*balance first$/m);
  assert.match(primary, /^\s*server pg-a \S+ check inter 3s fall 3 rise 2 agent-check agent-port 25436 agent-inter 2s$/m);
  assert.match(primary, /^\s*server pg-b \S+ check inter 3s fall 3 rise 2 agent-check agent-port 25436 agent-inter 2s$/m);
  // pg_primary 內不准出現 `backup`：靜態備援標記會在「沒有任何節點自稱 primary」時讓待命庫接到寫入。
  const primaryEffective = primary.split("\n").filter((l) => !isComment(l)).join("\n");
  assert.doesNotMatch(primaryEffective, /(?:^|\s)backup(?:\s|$)/);
  // 讀取端點仍保留 pg-b 為 backup（pg_ro 的讀取備援）。
  const standby = backendBlock(cfg, "pg_standby_first");
  assert.match(standby, /^\s*server pg-b \S+ check inter 3s fall 3 rise 2 backup$/m);
});

test("haproxy.cfg 有 listen internal_stats（容器內 bind :8404、唯讀）", () => {
  const cfg = readFileSync(cfgPath, "utf8");
  assert.match(cfg, /^listen internal_stats$/m);
  const block = cfg.slice(cfg.search(/^listen internal_stats$/m));
  assert.match(block, /^\s*bind :8404$/m, "容器內必須綁全介面（127.0.0.1:8404 會被 Docker 轉發擋住）");
  assert.match(block, /^\s*mode http$/m);
  assert.match(block, /^\s*stats enable$/m);
  assert.match(block, /^\s*stats admin if FALSE$/m, "stats 必須唯讀（無 admin）");
});

test("haproxy.cfg web_nodes 的加權註解要寫到三個理由（不是 50/50／漸進／web-a 保留 30）", () => {
  // 這條不驗語法，驗「為什麼」有沒有留下來：註解是下一個 session 唯一的決策依據。
  const cfg = readFileSync(cfgPath, "utf8");
  const block = backendBlock(cfg, "web_nodes");
  const comments = block
    .split("\n")
    .filter((l) => isComment(l))
    .join("\n");
  assert.match(comments, /50\/50/, "要寫清楚為什麼不做 50/50（含實測數字）");
  assert.match(comments, /3,915ms/);
  assert.match(comments, /5,240ms/);
  assert.match(comments, /漸進/, "要寫清楚 stick-table 讓效果是漸進的");
  assert.match(comments, /30/, "要寫清楚 web-a 保留 30 是刻意的（PG primary 宿主＋failover 目標）");
});

test("守護測試有牙齒：拿掉 weight／改成 50/50／歸零／漏 server 都要判紅", () => {
  // 用自帶的 fixture（不依賴 repo 檔現況）——這樣「檢查邏輯本身有沒有牙齒」與
  // 「repo 檔現在對不對」是兩件獨立的事，不會互相掩護。
  const GOOD = [
    "backend web_nodes",
    "    mode http",
    "    option httpchk GET /api/health",
    "    server web-a ${CASAOS_HOST}:15153 check inter 3s fall 3 rise 2 weight 30",
    "    server web-b ${SYNOLOGY_HOST}:15153 check inter 3s fall 3 rise 2 weight 70",
    "",
  ].join("\n");
  assert.equal(checkWebWeights(GOOD).ok, true, "fixture must pass before mutation");

  const mutants = {
    "weight 整段拿掉（回 roundrobin 50/50）": GOOD.replace(" weight 30", "").replace(" weight 70", ""),
    "只有 web-a 有 weight": GOOD.replace(" weight 70", ""),
    "改成 50/50": GOOD.replace("weight 30", "weight 50").replace("weight 70", "weight 50"),
    "對調成 70/30（把新流量壓到慢的 web-A）": GOOD.replace(/weight (\d+)/, (_m, v) => `weight ${v === "30" ? "70" : "30"}`),
    "web-a 歸零": GOOD.replace("weight 30", "weight 0"),
    "整條 server web-b 被刪掉": GOOD.replace(/\n\s*server web-b .*$/m, ""),
    "weight 寫成非數字": GOOD.replace("weight 30", "weight high"),
    "weight 超過上限": GOOD.replace("weight 70", "weight 1000"),
  };

  for (const [label, mutated] of Object.entries(mutants)) {
    assert.notEqual(mutated, GOOD, `mutant "${label}" did not change the fixture (test itself is stale)`);
    const r = checkWebWeights(mutated);
    assert.equal(r.ok, false, `mutant "${label}" should FAIL the check but passed`);
  }
});
