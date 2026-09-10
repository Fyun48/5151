import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(dir, "..", p), "utf8");
const html = read("public/index.html");
const server = read("src/server.js");

test("copy / template / contact tools exist in publish UI", () => {
  assert.match(html, /複製刊登/);
  assert.match(html, /將建立一份新的刊登草稿，原物件不會被修改/);
  assert.match(html, /新增\/修改 說明範本/);
  assert.match(html, /新增聯絡人/);
  assert.match(html, /套用並取代目前內容/);
  assert.match(html, /id="descTemplateManage"/);
  assert.match(html, /id="contactProfileManage"/);
  assert.match(html, /function copyOwnListing/);
  assert.match(html, /self-listings\/\$\{editingDraftId\}\/publish/);
  assert.doesNotMatch(html, /data-canned-body|家庭整層套用/);
  assert.doesNotMatch(html, /贊助廣告/);
});

test("selecting a template or contact applies immediately; manage overlay has delete only", () => {
  assert.doesNotMatch(html, /id="descTemplateApply"/);
  assert.doesNotMatch(html, /id="contactProfileApply"/);
  assert.doesNotMatch(html, /data-tpl-apply/);
  assert.doesNotMatch(html, /data-contact-apply/);
  assert.match(html, /\$\("descTemplatePick"\)\?\.addEventListener\("change"/);
  assert.match(html, /\$\("contactProfilePick"\)\?\.addEventListener\("change"/);
  assert.match(html, /if \(id\) applyDescTemplate\(id\)/);
  assert.match(html, /if \(id\) applyContactProfile\(id\)/);
  assert.match(html, /data-tpl-del/);
  assert.match(html, /data-contact-del/);
  assert.match(html, /descTemplatePick"\)\?\.value === String\(delId\)/);
  assert.match(html, /contactProfilePick"\)\?\.value === String\(delId\)/);
  assert.match(html, /selfBody"\)\.value === gone\.body/);
  assert.match(html, /selfContactName"\)\.value === \(gone\.contact_name/);
  assert.match(html, /descTemplatePick"\)\.value = String\(data\.id\)/);
  assert.match(html, /contactProfilePick"\)\.value = String\(data\.id\)/);
});

test("self listing form uses helper templates, required title, and bidirectional address", () => {
  const post = html.slice(html.indexOf('id="listingTools"'), html.indexOf('id="selfMineList"'));
  assert.match(html, /說明範本贊助會員可存到 5 則/);
  assert.doesNotMatch(html, /一般會員可存 2 則說明範本/);
  assert.doesNotMatch(html, /一般會員最多 2 則，贊助會員可存到 5 則/);
  assert.doesNotMatch(html, /從下拉選單選到就會套用；若說明已有字/);
  assert.match(post, /for="selfTitle">標題</);
  assert.match(html, /id="selfTitle"[^>]*minlength="5"/);
  assert.match(html, /標題至少 5 個字/);
  assert.match(post, /欲出租物件地址/);
  assert.match(post, />出租樓層</);
  assert.doesNotMatch(html, /路名地址/);
  assert.doesNotMatch(html, /所在樓層/);
  assert.doesNotMatch(html, /請先選縣市與行政區/);
  assert.match(html, /function applySelectsToAddress/);
  assert.match(html, /function applyAddressToSelects/);
  assert.match(html, /selfAddress"\)\?\.addEventListener\("blur"/);
  assert.match(post, /id="selfContactName" type="hidden"/);
  assert.match(post, /id="selfPhone" type="hidden"/);
  assert.match(post, /id="selfLine" type="hidden"/);
  assert.doesNotMatch(post, /聯絡人稱呼/);
  assert.doesNotMatch(post, /公開電話/);
  assert.doesNotMatch(post, /LINE 連結/);
  assert.doesNotMatch(html, /id="selfBodyEditor"/);
  assert.match(html, /id="descBodyEditor"/);
  assert.match(html, /id="descTemplateEditConfirm"/);
  assert.match(html, /確認修改/);
  assert.match(html, /data-tpl-edit/);
  assert.doesNotMatch(html, /item\.is_account \? "（不可刪）"/);
  assert.match(html, /data-avatar-zoom/);
  assert.match(html, /openAppLightbox\(\[src\], 0\)/);
  assert.ok(html.indexOf('id="listingTools"') < html.indexOf('id="selfTitle"'));
});

test("server exposes listing tool routes with auth hooks", () => {
  assert.match(server, /app\.post\("\/api\/self-listings\/:id\/copy"/);
  assert.match(server, /app\.post\("\/api\/self-listings\/:id\/publish"/);
  assert.match(server, /app\.get\("\/api\/listing-description-templates"/);
  assert.match(server, /app\.post\("\/api\/listing-contact-profiles"/);
  assert.match(server, /copyOwnListingFor\(session\.userId/);
});
