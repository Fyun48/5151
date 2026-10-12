// 突變驗證（red-ability）——從 ui-p1-a11y-w2 的 evidence 目錄收進 repo 的可重跑版本。
//
// 做什麼：把每一條被守門的斷言「各自回退一次」，確認對應測試真的會紅（不是永遠綠的空殼測試），
// 每次都「改一個字串 → 跑測試 → 逐字還原」，並用 sha256 確認還原後與原檔相同。
//
// 用法（在 repo 根目錄）：
//   node v3/scripts/mutate-ui-a11y-markup.mjs              # 全部
//   node v3/scripts/mutate-ui-a11y-markup.mjs --only R3-1  # 只跑名稱含 R3-1 的
//   node v3/scripts/mutate-ui-a11y-markup.mjs --list       # 只列出突變清單
//
// ⚠️ 這支會**暫時改動工作樹裡的檔案**（跑完一定還原，還原失敗就非零退出）。
//    請在你自己的 worktree 跑，不要對共享 checkout 跑。
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? args[onlyAt + 1] : "";
const TEST = "v3/test/ui-a11y-markup.test.js";

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// 每條突變：file（相對 repo 根）／from／to／expect（預期會紅的測試名前綴）
const MUTATIONS = [
  {
    name: "R3-1 拔掉 loadList 的 15 秒逾時",
    file: "v3/public/index.html",
    from: "          { signal: AbortSignal.timeout(LIST_FETCH_TIMEOUT_MS) },\n        );\n        const data = await readApi(res);",
    to: "        );\n        const data = await readApi(res);",
    expect: "R3-1 路線永不回應",
  },
  {
    name: "R3-1 拿掉 catch（失敗／逾時不收尾）",
    file: "v3/public/index.html",
    from: '      } catch (error) {\n        // 逾時／失敗都要收尾：狀態列換成明確的失敗文案，busy 交給 finally（同一個世代守衛）。\n        if (gen === listLoadGen && $("status")) $("status").textContent = listFetchFailureText(error, "更新失敗");\n        throw error;\n',
    to: "",
    expect: "R3-1 非逾時的失敗",
  },
  {
    name: "B2 讓逾時後綴回到所有錯誤（第二期 reviewer 指正的那條回歸）",
    file: "v3/public/index.html",
    from: '      if (!timedOut) return error?.message || fallback;\n      const seconds = Math.round(LIST_FETCH_TIMEOUT_MS / 1000);\n      return `更新逾時（${seconds} 秒），請再點一次重新載入`;',
    to: '      const seconds = Math.round(LIST_FETCH_TIMEOUT_MS / 1000);\n      return timedOut\n        ? `更新逾時（${seconds} 秒），請再點一次重新載入`\n        : `${error?.message || fallback}，請再點一次重新載入`;',
    expect: "B2 逾時文案只在真的逾時出現",
  },
  {
    name: "A 拿掉空狀態的 live region（role=status／aria-live）",
    file: "v3/public/index.html",
    from: '<div class="empty empty-explain" role="status" aria-live="polite" aria-atomic="true">',
    to: '<div class="empty empty-explain">',
    expect: "A 空狀態是 live region",
  },
  {
    name: "C① 把 --watch 改回 #9a6b6b（AA 以下的原值）",
    file: "v3/public/tokens.css",
    from: "  --watch: #896060;",
    to: "  --watch: #9a6b6b;",
    expect: "本期色票",
  },
  {
    name: "R3-2 拿掉 roving tabindex 的同步",
    file: "v3/public/index.html",
    from: "        el.tabIndex = selected ? 0 : -1;",
    to: "",
    expect: "R3-2 分頁是完整的 APG tabs",
  },
  {
    name: "R3-2 拿掉方向鍵綁定",
    file: "v3/public/index.html",
    from: '      el.addEventListener("keydown", (ev) => {',
    to: '      void ((ev) => {',
    expect: "R3-2 分頁的左右方向鍵",
  },
  {
    name: "R3-3 拿掉 memberMailText 的 for=",
    file: "v3/public/index.html",
    from: '<label for="memberMailText">物件通知本文</label>',
    to: "<label>物件通知本文</label>",
    expect: "R3-3 通知 hub 的郵件本文",
  },
  {
    name: "R3-4 拿掉選取分頁的 hover 覆蓋規則",
    file: "v3/public/index.html",
    from: '    .hub-tabs button[aria-selected="true"]:hover {\n      background: var(--accent);\n      color: var(--primary-foreground);\n      border-color: var(--accent);\n    }\n',
    to: "",
    expect: "R3-4 選取中的分頁 hover",
  },
];

const selected = MUTATIONS.filter((m) => !only || m.name.includes(only));
if (args.includes("--list")) {
  for (const m of selected) console.log(`${m.name}  → 預期紅：${m.expect}  (${m.file})`);
  process.exit(0);
}
if (!selected.length) {
  console.error(`沒有符合 --only ${only} 的突變`);
  process.exit(2);
}

// 先把每個檔案的原內容讀進來；同一檔案可能被多條突變用到，所以用 Map 保存、每輪都從原內容出發。
const originals = new Map();
for (const file of new Set(selected.map((m) => m.file))) {
  const abs = path.join(ROOT, file);
  originals.set(file, { abs, text: readFileSync(abs, "utf8") });
}
for (const [file, { text }] of originals) console.log(`原始 sha(${file}) = ${sha(text)}`);

const report = [];
for (const mut of selected) {
  const { abs, text } = originals.get(mut.file);
  const count = text.split(mut.from).length - 1;
  if (count !== 1) throw new Error(`${mut.name}: 突變錨點在 ${mut.file} 命中 ${count} 次（預期 1）`);
  writeFileSync(abs, text.replace(mut.from, mut.to));
  let status = 0;
  let out = "";
  try {
    out = execFileSync("node", ["--test", TEST], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    status = error.status ?? 1;
    out = String(error.stdout || "") + String(error.stderr || "");
  }
  writeFileSync(abs, text);
  const restored = sha(readFileSync(abs, "utf8"));
  const failedNames = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const hit = failedNames.some((n) => n.startsWith(mut.expect));
  report.push({
    突變: mut.name,
    exit: status,
    紅燈測試數: failedNames.length,
    命中預期測試: hit,
    紅燈測試: failedNames,
    還原後sha一致: restored === sha(text),
  });
  console.log(`${hit && status !== 0 ? "PASS" : "FAIL"} ${mut.name}（紅燈 ${failedNames.length} 條，命中預期=${hit}）`);
  if (status === 0 || !hit || restored !== sha(text)) {
    console.error(JSON.stringify(report, null, 1));
    throw new Error(`${mut.name}: 突變沒有被預期測試攔下（exit=${status}, hit=${hit}, 還原=${restored === sha(text)}）`);
  }
}
console.log(JSON.stringify(report, null, 1));
