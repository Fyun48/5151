// R3（第二輪複審）：回饋附圖的**世代隔離**要用實際的頁面函式跑，不是只驗字串。
//
// 審閱指出的兩個缺口（舊版只保護「成功」那一條路徑）：
//   1. A 上傳還沒回來 → 關閉／重開 → B 開始上傳 → A 回來時把 **B 的 busy 清成 false**
//      ⇒ B 還沒完成就能送出回饋。
//   2. A 回 409 時，錯誤分支**在世代檢查之前**就把舊附件接回清單 ⇒ 舊結果混進新對話框。
//
// 這一支把 `index.html` 的 C3 區塊（真的那一份原始碼）抽出來，配上可控的 `fetch`
// （deferred promise）與最小 DOM，實際跑 A／B 交錯。抽出的範圍與 `openFeedbackDialog`
// 的世代重置都有字串守衛，避免「改了頁面但測試測到舊程式」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function extractBlock() {
  const start = html.indexOf("// ── C3：回饋附圖 ──");
  const end = html.indexOf("function openFeedbackDialog()", start);
  assert.ok(start > 0 && end > start, "找得到 index.html 的 C3 區塊");
  return html.slice(start, end);
}

/** 最小 DOM：只實作 C3 會用到的節點與操作。 */
function makeDom() {
  const nodes = new Map();
  const mk = (id, tag = "div") => {
    const el = {
      id,
      tagName: tag.toUpperCase(),
      hidden: false,
      disabled: false,
      textContent: "",
      className: "",
      dataset: {},
      classList: { toggle() {}, add() {}, remove() {} },
      innerHTML: "",
      children: [],
      style: {},
      addEventListener() {},
      querySelectorAll: () => [],
    };
    nodes.set(id, el);
    return el;
  };
  for (const id of ["feedbackImageMsg", "feedbackImageTray", "feedbackImageCount", "feedbackImagePick", "feedbackSubmit", "feedbackBody", "feedbackDialog", "feedbackImages"]) mk(id);
  const document = {
    getElementById: (id) => nodes.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => mk(`tmp-${Math.random()}`),
  };
  return { document, nodes };
}

/**
 * 用頁面真正的 C3 函式建一個測試沙盒。
 * `responses` 是「依呼叫順序」的 deferred 控制器，讓測試自己決定誰先回來。
 */
function makeSandbox({ document, nodes, url = { createObjectURL: () => "blob:test", revokeObjectURL() {} } }) {
  const pending = [];
  const fetchCalls = [];
  const fetchImpl = (input, init = {}) => {
    // DELETE 也要記下來（測試要驗「舊世代的附件有沒有被清掉」），只是它會立刻成功。
    const entry = { url: String(input), method: String(init.method || "GET") };
    fetchCalls.push(entry);
    if (init.method === "DELETE") return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    return new Promise((resolve) => {
      pending.push({
        entry,
        settle: (body, ok = true, status = 200) => resolve({
          ok,
          status,
          json: async () => body,
        }),
      });
    });
  };
  const readApi = async (res) => res.json();
  const $ = (id) => nodes.get(id) || null;
  const esc = (v) => String(v == null ? "" : v);

  const src = extractBlock();
  const factory = new Function(
    "document", "window", "fetch", "readApi", "$", "esc", "URL", "setTimeout", "clearTimeout",
    `${src}
     return {
       addFeedbackImages, removeFeedbackImage, clearFeedbackImages, renderFeedbackImageTray,
       state: () => ({ busy: feedbackImageBusy, generation: feedbackImageGeneration, rows: feedbackAttachments.map((r) => r.id) }),
       openDialog: () => { feedbackImageGeneration += 1; feedbackImageBusy = false; },
     };`,
  );
  const api = factory(document, { clearTimeout() {}, setTimeout() {} }, fetchImpl, readApi, $, esc, url, setTimeout, clearTimeout);
  return { api, pending, fetchCalls, nodes };
}

test("R3：A 未完成 → 關閉重開 → B 上傳中，A 回來不可以把 B 的 busy 清掉", async () => {
  const dom = makeDom();
  const box = makeSandbox(dom);
  // A 開始上傳
  const aPromise = box.api.addFeedbackImages([{ type: "image/png", size: 100, name: "a.png" }]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(box.api.state().busy, true, "A 上傳中 ⇒ busy");
  // 關閉對話框（換世代）→ 重新開啟 → B 開始上傳
  await box.api.clearFeedbackImages();
  box.api.openDialog();
  const bPromise = box.api.addFeedbackImages([{ type: "image/png", size: 100, name: "b.png" }]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(box.api.state().busy, true, "B 上傳中 ⇒ busy");
  // A 這時候才回來（成功）
  box.pending[0].settle({ id: 11, thumb_url: "/api/feedback/attachments/11/thumb" }, true, 200);
  await aPromise;
  assert.equal(box.api.state().busy, true, "A 回來不可以清掉 B 的 busy（B 還沒完成）");
  assert.deepEqual(box.api.state().rows, [], "A 的結果不可以進到新對話框");
  // 而且 A 那一張要被刪掉（不留孤兒）
  assert.ok(box.fetchCalls.some((c) => c.url.includes("/api/feedback/attachments/11")), "A 的附件要發 DELETE 清掉");
  // B 回來才收尾
  box.pending[1].settle({ id: 22, thumb_url: "/api/feedback/attachments/22/thumb" }, true, 200);
  await bPromise;
  assert.equal(box.api.state().busy, false, "B 完成後才清 busy");
  assert.deepEqual(box.api.state().rows, [22], "新對話框只留 B");
});

test("R3：舊世代的 409（附帶舊附件清單）不可以混進新對話框", async () => {
  const dom = makeDom();
  const box = makeSandbox(dom);
  const aPromise = box.api.addFeedbackImages([{ type: "image/png", size: 100, name: "a.png" }]);
  await new Promise((r) => setTimeout(r, 0));
  await box.api.clearFeedbackImages();
  box.api.openDialog();
  // A 回來的是 409，而且 body 帶著「目前還沒送出的附件」
  box.pending[0].settle({
    error: "每則回饋最多 4 張圖片，請先刪除再上傳",
    code: "attachment_limit",
    attachments: [{ id: 77, thumb_url: "/api/feedback/attachments/77/thumb" }],
  }, false, 409);
  await aPromise;
  assert.deepEqual(box.api.state().rows, [], "舊世代的附件清單不可以被接進新對話框");
  assert.equal(box.api.state().busy, false, "舊世代回來後不該讓新世代卡在 busy");
  assert.equal(dom.nodes.get("feedbackImageMsg").textContent, "", "舊世代的錯誤訊息也不可以寫進新對話框");
});

test("R3：同一世代內，409 的附件清單仍要接回清單（上限恢復路徑不能被世代保護擋掉）", async () => {
  const dom = makeDom();
  const box = makeSandbox(dom);
  const p = box.api.addFeedbackImages([{ type: "image/png", size: 100, name: "a.png" }]);
  await new Promise((r) => setTimeout(r, 0));
  box.pending[0].settle({
    error: "每則回饋最多 4 張圖片，請先刪除再上傳",
    attachments: [{ id: 77, thumb_url: "/api/feedback/attachments/77/thumb" }],
  }, false, 409);
  await p;
  assert.deepEqual(box.api.state().rows, [77], "同一世代內要接回清單，使用者才刪得掉");
  assert.equal(box.api.state().busy, false);
  assert.match(dom.nodes.get("feedbackImageMsg").textContent, /最多 4 張/);
});

test("R3：頁面的開／關對話框仍然會換世代並重置 busy（測試不能與頁面脫節）", () => {
  const open = html.slice(html.indexOf("function openFeedbackDialog()"), html.indexOf("function closeFeedbackDialog()"));
  assert.match(open, /feedbackImageGeneration \+= 1;/);
  assert.match(open, /feedbackImageBusy = false;/);
  const close = html.slice(html.indexOf("function closeFeedbackDialog()"), html.indexOf("function closeFeedbackDialog()") + 260);
  assert.match(close, /clearFeedbackImages\(\)/);
  assert.match(html, /feedbackImageGeneration \+= 1;\n      \/\/ 上一代的 busy 由這一代接手管理/);
});
