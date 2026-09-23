import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");

// 首頁 boot 區塊：檔案裡有多處 loadState()（例如 reloadBtn），所以用唯一的收尾錨點往回切。
function bootBlock() {
  const end = html.indexOf("setTimeout(() => map?.invalidateSize(), 250);");
  assert.ok(end > 0, "找不到首頁 boot 區塊的收尾錨點");
  return html.slice(Math.max(0, end - 8000), end);
}

function splitBootAtLoadState() {
  const boot = bootBlock();
  const stateAt = boot.lastIndexOf("loadState().catch(");
  assert.ok(stateAt > 0, "首頁 boot 區塊應包含 loadState()");
  return { before: boot.slice(0, stateAt), after: boot.slice(stateAt) };
}

// 為什麼要鎖這個順序：訪客路徑的 loadState() 最後會 await 公開房源查詢，
// 正式站冷啟動實測 /api/public/listings 要 28 秒（warm 1.3 秒）、/api/comms 只要 0.35 秒。
// 把公告／支持入口／廣告／廣播留在 loadState().then() 裡，會讓「支持本站」入口等到 30 秒後才出現。
test("公告／支持入口／廣告／廣播不等 loadState()：慢的公開房源查詢不該延後它們", () => {
  const { before, after } = splitBootAtLoadState();
  for (const call of [
    "ensureServiceWorker();",
    "loadComms().catch(() => {});",
    "loadPublicAds().catch(() => {});",
    "loadBroadcasts().catch(() => {});",
  ]) {
    assert.ok(before.includes(call), `${call} 必須在 loadState() 之前就先送出`);
    assert.ok(!after.includes(call), `${call} 不應留在 loadState() 的 .then() 裡（會被公開房源查詢卡住）`);
  }
});

test("品牌／贊助提示仍留在 loadState() 之後（要等 isGuest / mePlan 才知道要不要顯示）", () => {
  const { after } = splitBootAtLoadState();
  assert.match(after, /JibbyMascot\?\.load\?\.\(\)/);
  assert.match(after, /isGuest/);
  assert.match(after, /mePlan/);
});
