import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 兩份 HAProxy compose 的「有效行」必須逐字一致（只差 `-b` 後綴）——2026-10-12 立的規則。
//
// 為什麼要有這條：正式機 casa `5151-shadow-haproxy` 與 syn `5151-shadow-haproxy-b` 兩份 compose
// 的有效行**完全相同**（只有 `name:`／service 名／`container_name:` 的 `-b` 後綴不同；命令都用
// `haproxy:2.9-alpine` 的**映像預設**，planner 以 `docker inspect -f "{{.Args}}"` 在兩台實讀核對）。
// 但 repo 曾經只在 casa 那份加了顯式 `command:`（syn 沒加）＝「一份有加、一份沒加」的漂移，
// 而且那個 `command:` 在 live 根本不存在 ⇒ 這條測試把「兩邊一致」與「不准有 `command:`」都變成
// 會紅的斷言（見最後一個 test 的 mutant 證明）。
//
// 這是**離線**靜態檢查：只讀兩個檔案，不連任何主機、不起容器。

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CASA = "deploy/shadow-ha/haproxy/docker-compose.yml";
const SYN = "deploy/shadow-ha/haproxy/docker-compose.synology.yml";

// 有效行＝拿掉空行與整行註解（與 `grep -avE '^\s*#|^\s*$'` 同義）。
function effectiveLines(text) {
  return text.split("\n").filter((line) => line.trim() && !/^\s*#/.test(line));
}

// 兩份唯一的合法差異是 `-b` 後綴，比對前先正規化掉。
function normalize(line) {
  return line.replace(/haproxy-[bB]/g, "haproxy");
}

export function checkComposeParity(casaText, synText) {
  const problems = [];
  const casa = effectiveLines(casaText);
  const syn = effectiveLines(synText);

  for (const [name, lines] of [
    [CASA, casa],
    [SYN, syn],
  ]) {
    if (lines.some((l) => /(?:^|\s)command:/.test(l))) {
      problems.push(
        `${name}: 不該有 "command:"（live 兩台都用映像預設命令；要改命令就必須兩台都改且先同步 live）`,
      );
    }
  }

  if (casa.length !== syn.length) {
    problems.push(`有效行數不同：${CASA}=${casa.length} 行 vs ${SYN}=${syn.length} 行`);
  }

  const a = casa.map(normalize);
  const b = syn.map(normalize);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      problems.push(
        `第 ${i + 1} 條有效行不同：${CASA}="${a[i] ?? "(缺少)"}" vs ${SYN}="${b[i] ?? "(缺少)"}"`,
      );
    }
  }

  return { ok: problems.length === 0, problems, counts: { casa: casa.length, syn: syn.length } };
}

test("兩份 haproxy compose 的有效行逐字一致（只差 -b 後綴），且都不含 command:", () => {
  const r = checkComposeParity(
    readFileSync(path.join(root, CASA), "utf8"),
    readFileSync(path.join(root, SYN), "utf8"),
  );
  assert.deepEqual(r.problems, [], r.problems.join("\n"));
  // 13 條＝name／services／service 名／container_name／image／restart／ports／4 個埠／volumes／mount。
  assert.deepEqual(r.counts, { casa: 13, syn: 13 });
});

test("守護測試有牙齒：只在一邊加東西、或兩邊都加 command:，都要判紅", () => {
  // 自帶 fixture（不依賴 repo 檔現況）——「檢查邏輯有沒有牙齒」與「repo 檔現在對不對」要各自獨立。
  const CASA_FIX = [
    "name: 5151-shadow-haproxy",
    "",
    "services:",
    "  5151-haproxy:",
    "    container_name: 5151-haproxy",
    "    image: haproxy:2.9-alpine",
    "    restart: unless-stopped",
    "    ports:",
    '      - "0.0.0.0:25433:25433"',
    '      - "0.0.0.0:25434:25434"',
    '      - "0.0.0.0:25153:15153"',
    '      - "127.0.0.1:25154:8404"',
    "    volumes:",
    "      - ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro",
    "",
  ].join("\n");
  const SYN_FIX = CASA_FIX.replace(/haproxy-b/g, "haproxy")
    .replace("name: 5151-shadow-haproxy", "name: 5151-shadow-haproxy-b")
    .replace("  5151-haproxy:", "  5151-haproxy-B:")
    .replace("container_name: 5151-haproxy", "container_name: 5151-haproxy-B");

  assert.equal(checkComposeParity(CASA_FIX, SYN_FIX).ok, true, "fixture must pass before mutation");

  const CMD = '    command: ["haproxy", "-W", "-db", "-f", "/usr/local/etc/haproxy/haproxy.cfg"]\n';
  const mutants = {
    "只在 casa 加 command:": [CASA_FIX.replace("    image: haproxy:2.9-alpine\n", "    image: haproxy:2.9-alpine\n" + CMD), SYN_FIX],
    "兩邊都加 command:（一致但仍然錯）": [
      CASA_FIX.replace("    image: haproxy:2.9-alpine\n", "    image: haproxy:2.9-alpine\n" + CMD),
      SYN_FIX.replace("    image: haproxy:2.9-alpine\n", "    image: haproxy:2.9-alpine\n" + CMD),
    ],
    "只在 syn 少一個埠映射": [CASA_FIX, SYN_FIX.replace('      - "127.0.0.1:25154:8404"\n', "")],
    "只在 casa 多掛一個 render-and-run.sh": [
      CASA_FIX.replace(
        "      - ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro",
        "      - ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro\n      - ./render-and-run.sh:/usr/local/bin/render-and-run.sh:ro",
      ),
      SYN_FIX,
    ],
    "只在 syn 少 restart: unless-stopped": [
      CASA_FIX,
      SYN_FIX.replace("    restart: unless-stopped\n", ""),
    ],
  };

  for (const [label, [casaMut, synMut]] of Object.entries(mutants)) {
    assert.notEqual(
      casaMut + "\u0000" + synMut,
      CASA_FIX + "\u0000" + SYN_FIX,
      `mutant "${label}" did not change the fixture (test itself is stale)`,
    );
    const r = checkComposeParity(casaMut, synMut);
    assert.equal(r.ok, false, `mutant "${label}" should FAIL the check but passed`);
  }
});
