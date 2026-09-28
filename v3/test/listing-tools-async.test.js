// 刊登生產力工具（說明範本 ＋ 聯絡人）PG 分支的 parity（2026-09-27）。
//
// `listingToolsAsync.js` 這 10 條路由（`/api/listing-description-templates` 5 條、
// `/api/listing-contact-profiles` 5 條）有四個一定要釘住的地方：
//
//   1. **方言**：同步版用 `IFNULL(is_account,0)`，PG 不接受，而且注入式 `exec` 不經過
//      `toPostgresSql` ⇒ PG 分支必須寫 `COALESCE`。夾具會主動拒絕 `IFNULL`。
//   2. **上限**：說明範本免費 2 則／贊助 5 則、聯絡人 2 則。這是最容易寫成「永遠不會觸發」
//      的守衛——測試一定要**真的撞到上限**（斷言 409 與 code），否則是空測試。
//   3. **同名合併**：建立時同名是「更新既有那一筆」而不是新增；更新時改成另一個已存在的
//      名稱是「合併進那一筆」。兩者都會改變**列數**，所以要比落地結果，不是只看回傳值。
//   4. **帳號聯絡人**：自動建立、鎖定不可改／不可刪，而且「一位使用者最多一筆」是靠
//      **部分唯一索引**（`WHERE is_account = 1`）保證的。那個索引在 PG 正式站**不存在**
//      （匯入時 indexes:false），所以 `ensureListingToolsStoreOnce()` 必須補建它——
//      這一條用一支假的 pgDriver 驗證「先清重複、再建索引」的順序與只做一次。
//
// 每個動作都比對**落地的列**（disk vs fixture），不是只比回傳值：回傳值相同但寫錯表的
// 情況，本系列已經踩過。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-listingtools-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = (await import("../src/db.js")).sqliteHandle();
const sync = await import("../src/listingTools.js");
const asyncMod = await import("../src/listingToolsAsync.js");

const PG = { driver: "postgres" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const LATER = new Date("2026-06-02T00:00:00.000Z");
const TABLES = ["listing_description_template", "listing_contact_profile", "listing_copy_idempotency"];
const diskPath = () => path.join(dataDir, "v3.db");

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
];

// PG 替身：三張表的 DDL 與**索引**都從真的 sqlite_master 抄（不手寫欄位——本系列憑印象
// 寫欄位名已經踩過三次）。索引也要抄：部分唯一索引是「一位使用者最多一筆帳號聯絡人」的
// 實際保證，少了它就測不到 PG 那邊的同一件事。
function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const table of TABLES) {
    const ddl = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(ddl?.sql, `必須抓到 ${table} 的 DDL`);
    mem.exec(ddl.sql);
  }
  for (const row of disk.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND tbl_name IN (?,?,?)",
  ).all(...TABLES)) {
    if (/\bON\s+sqlite_/i.test(row.sql)) continue;
    mem.exec(row.sql);
  }
  const ddl = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  assert.ok(ddl?.sql, "必須抓到 users 的 DDL");
  mem.exec(ddl.sql);
  disk.close();
  const calls = [];
  const exec = async (sql, params = []) => {
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    calls.push({ sql, params });
    return mem.prepare(sql).all(...params);
  };
  exec.raw = mem;
  exec.calls = calls;
  return exec;
}

// 這一輪的 PG 分支只碰這幾張表；每次測試前把兩邊清成同一狀態。
function resetBoth() {
  const exec = pgFixture();
  for (const table of TABLES) {
    db.prepare(`DELETE FROM ${table}`).run();
    exec.raw.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare("DELETE FROM users WHERE email LIKE '%@example.test'").run();
  exec.raw.exec("DELETE FROM users WHERE email LIKE '%@example.test'");
  // AUTOINCREMENT 的計數器也要歸零，否則兩邊的 id 會不同，落地比對就失去意義。
  try { db.prepare("DELETE FROM sqlite_sequence WHERE name IN (?,?,?)").run(...TABLES); } catch { /* 沒有 AUTOINCREMENT */ }
  return exec;
}

function seedUser(handle, { id, email, nickname = "", lineId = "", contactPhone = "" }) {
  const info = handle.prepare("PRAGMA table_info(users)").all();
  const provided = {
    id, email, nickname, line_id: lineId, contact_phone: contactPhone,
    role: "member", plan: "free", deleted_at: null, created_at: "2026-01-01T00:00:00.000Z",
  };
  const required = info.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
  const names = info.map((c) => c.name).filter((n) => n in provided || required.some((c) => c.name === n));
  handle.prepare(`INSERT INTO users(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(...names.map((n) => {
      if (n in provided) return provided[n];
      const col = info.find((c) => c.name === n);
      return /INT|REAL|NUM/i.test(col.type) ? 0 : "";
    }));
}

const dump = (handle, table) =>
  handle.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((r) => ({ ...r }));

function assertSameRows(exec, table, why) {
  const a = dump(db, table);
  const b = dump(exec.raw, table);
  assert.deepEqual(b, a, `${why}：PG 分支落地的 ${table} 必須與同步版完全相同`);
  assert.ok(a.length > 0 || why.includes("空"), `${why}：兩邊都是 0 列時這個比對沒有鑑別力`);
}

const seedPair = (exec, opts) => { seedUser(db, opts); seedUser(exec.raw, opts); };

const reasonOf = (error) => `${error.status}/${error.code || "-"}/${error.message}`;

// ---------------------------------------------------------------------------
// 說明範本

test("建立範本：PG 與同步版的回傳形狀與落地列都相同（逐欄比對，不是只比 deepEqual）", async () => {
  const exec = resetBoth();
  seedPair(exec, { id: 101, email: "t1@example.test" });
  const input = { name: "  兩房物件  ", body: "<p>近捷運，可寵</p>" };

  const pg = await asyncMod.createDescriptionTemplateAsync(101, input, { now: NOW, ...PG, exec });
  const lite = sync.createDescriptionTemplate(db, 101, input, NOW, {});

  assert.equal(pg.id, lite.id, "id 必須相同");
  assert.equal(pg.name, "兩房物件", "名稱要去空白（兩邊都要）");
  assert.equal(pg.name, lite.name);
  assert.equal(pg.body, lite.body, "body 必須相同");
  assert.ok(pg.body.length > 0, "body 不得為空，否則比對沒有鑑別力");
  assert.equal(pg.sort_order, 0);
  assert.equal(pg.created_at, lite.created_at, "時間戳必須相同（兩邊都用注入的 now）");
  assert.equal(pg.updated_at, lite.updated_at);
  assert.equal(lite.created_at, NOW.toISOString());
  assertSameRows(exec, "listing_description_template", "建立範本");
});

test("建立範本：同名是「更新既有那一筆」而不是新增（列數不變、body 換掉）", async () => {
  const exec = resetBoth();
  seedPair(exec, { id: 102, email: "t2@example.test" });
  sync.createDescriptionTemplate(db, 102, { name: "同名", body: "<p>舊內容</p>" }, NOW, {});
  await asyncMod.createDescriptionTemplateAsync(102, { name: "同名", body: "<p>舊內容</p>" }, { now: NOW, ...PG, exec });

  const pg = await asyncMod.createDescriptionTemplateAsync(102, { name: "同名", body: "<p>新內容</p>" }, { now: LATER, ...PG, exec });
  const lite = sync.createDescriptionTemplate(db, 102, { name: "同名", body: "<p>新內容</p>" }, LATER, {});

  assert.equal(pg.id, lite.id);
  assert.equal(pg.id, 1, "必須是原本那一筆（不是新增）");
  assert.match(pg.body, /新內容/);
  assert.equal(pg.updated_at, LATER.toISOString());
  const rows = dump(exec.raw, "listing_description_template");
  assert.equal(rows.length, 1, "同名不得新增第二列");
  assertSameRows(exec, "listing_description_template", "同名更新");
});

test("免費上限 2 則：第 3 則必須被擋下（409／template_limit），贊助上限 5 則要放行", async () => {
  const exec = resetBoth();
  seedPair(exec, { id: 103, email: "t3@example.test" });
  for (const name of ["A", "B"]) {
    sync.createDescriptionTemplate(db, 103, { name, body: `<p>${name}</p>` }, NOW, {});
    await asyncMod.createDescriptionTemplateAsync(103, { name, body: `<p>${name}</p>` }, { now: NOW, ...PG, exec });
  }
  // 先確認第 3 則真的會撞到上限——否則這條測試只是「跑得過去」。
  let syncErr = null;
  try { sync.createDescriptionTemplate(db, 103, { name: "C", body: "<p>C</p>" }, NOW, {}); } catch (e) { syncErr = e; }
  assert.ok(syncErr, "同步版應該要擋下第 3 則");
  await assert.rejects(
    () => asyncMod.createDescriptionTemplateAsync(103, { name: "C", body: "<p>C</p>" }, { now: NOW, ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncErr),
    `PG 分支的錯誤必須與同步版一致（同步版：${syncErr && reasonOf(syncErr)}）`,
  );
  assert.equal(dump(exec.raw, "listing_description_template").length, 2, "被擋下就不得落地");

  // 贊助（5 則）要放行第 3 則——證明上面擋下來真的是「上限」而不是別的驗證。
  const sponsor = await asyncMod.createDescriptionTemplateAsync(
    103, { name: "C", body: "<p>C</p>" }, { now: NOW, ...PG, exec, plan: "sponsor" },
  );
  assert.equal(sponsor.name, "C");
  assert.equal(dump(exec.raw, "listing_description_template").length, 3);
});

test("更新範本：改成另一個已存在的名稱＝合併進那一筆（來源列不變、目標列拿到 body）", async () => {
  const exec = resetBoth();
  seedPair(exec, { id: 104, email: "t4@example.test" });
  for (const name of ["甲", "乙"]) {
    sync.createDescriptionTemplate(db, 104, { name, body: `<p>${name}的內容</p>` }, NOW, {});
    await asyncMod.createDescriptionTemplateAsync(104, { name, body: `<p>${name}的內容</p>` }, { now: NOW, ...PG, exec });
  }
  const pg = await asyncMod.updateDescriptionTemplateAsync(104, 1, { name: "乙", body: "<p>併過去的內容</p>" }, { now: LATER, ...PG, exec });
  const lite = sync.updateDescriptionTemplate(db, 104, 1, { name: "乙", body: "<p>併過去的內容</p>" }, LATER);

  assert.equal(pg.id, lite.id);
  assert.equal(pg.id, 2, "必須合併進 id=2 那一筆（乙）");
  assert.match(pg.body, /併過去的內容/);
  const rows = dump(exec.raw, "listing_description_template");
  assert.equal(rows.length, 2, "合併不得刪列也不得新增列");
  assert.equal(rows[1].name, "乙");
  assertSameRows(exec, "listing_description_template", "更新合併");
});

test("更新範本：只帶 body 時名稱要沿用舊值（`templateFields` 的 fallback）", async () => {
  // 同步版的 `input.name != null ? … : row.name` 這個 fallback 很容易在移植時漏掉，
  // 而漏掉的後果是「只改內文會把名稱清空」→ 名稱變空字串 → 下一次 `templateFields`
  // 直接 throw「請填範本名稱」，整個範本等於壞掉。
  const exec = resetBoth();
  seedPair(exec, { id: 110, email: "t10@example.test" });
  sync.createDescriptionTemplate(db, 110, { name: "原名稱", body: "<p>舊</p>" }, NOW, {});
  await asyncMod.createDescriptionTemplateAsync(110, { name: "原名稱", body: "<p>舊</p>" }, { now: NOW, ...PG, exec });

  const pg = await asyncMod.updateDescriptionTemplateAsync(110, 1, { body: "<p>只換內文</p>" }, { now: LATER, ...PG, exec });
  const lite = sync.updateDescriptionTemplate(db, 110, 1, { body: "<p>只換內文</p>" }, LATER);
  assert.deepEqual(pg, lite);
  assert.equal(pg.name, "原名稱", "沒帶 name 就必須沿用舊值");
  assert.match(pg.body, /只換內文/);
  assert.equal(dump(exec.raw, "listing_description_template")[0].name, "原名稱", "落地的那一列也要保留名稱");
  assertSameRows(exec, "listing_description_template", "部分欄位更新");
});

test("擁有權：找不到 → 404、別人的 → 403，而且兩邊的 status 與訊息完全相同", async () => {
  const exec = resetBoth();
  seedPair(exec, { id: 105, email: "t5@example.test" });
  seedPair(exec, { id: 106, email: "t6@example.test" });
  sync.createDescriptionTemplate(db, 105, { name: "我的", body: "<p>x</p>" }, NOW, {});
  await asyncMod.createDescriptionTemplateAsync(105, { name: "我的", body: "<p>x</p>" }, { now: NOW, ...PG, exec });

  for (const c of [{ method: "get", args: [106, 1] }, { method: "get", args: [105, 999] }]) {
    let syncErr = null;
    try { sync.getOwnedDescriptionTemplate(db, ...c.args); } catch (e) { syncErr = e; }
    let pgErr = null;
    try { await asyncMod.getOwnedDescriptionTemplateAsync(c.args[0], c.args[1], { ...PG, exec }); } catch (e) { pgErr = e; }
    assert.ok(syncErr, `同步版應該丟錯 ${c.method}(${c.args})`);
    assert.ok(pgErr, `PG 分支應該丟錯 ${c.method}(${c.args})`);
    assert.equal(reasonOf(pgErr), reasonOf(syncErr), `status／訊息必須相同（${c.args}）`);
  }

  // 刪除也要走同一道擁有權檢查（不能只測讀取）。
  let delSync = null;
  try { sync.deleteDescriptionTemplate(db, 106, 1); } catch (e) { delSync = e; }
  await assert.rejects(() => asyncMod.deleteDescriptionTemplateAsync(106, 1, { ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(delSync));
  assert.equal(dump(exec.raw, "listing_description_template").length, 1, "別人的範本不得被刪掉");
});

test("刪除範本：只刪自己那一筆，落地結果相同", async () => {
  const exec = resetBoth();
  seedPair(exec, { id: 107, email: "t7@example.test" });
  seedPair(exec, { id: 108, email: "t8@example.test" });
  for (const uid of [107, 108]) {
    sync.createDescriptionTemplate(db, uid, { name: `u${uid}`, body: "<p>x</p>" }, NOW, {});
    await asyncMod.createDescriptionTemplateAsync(uid, { name: `u${uid}`, body: "<p>x</p>" }, { now: NOW, ...PG, exec });
  }
  const pg = await asyncMod.deleteDescriptionTemplateAsync(107, 1, { ...PG, exec });
  const lite = sync.deleteDescriptionTemplate(db, 107, 1);
  assert.deepEqual(pg, lite);
  assert.deepEqual({ deleted: true }, pg, "回傳形狀必須是 { deleted: true }（不能只比兩邊相等）");
  const rows = dump(exec.raw, "listing_description_template");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, 108, "被刪掉的必須是自己那一筆");
  assertSameRows(exec, "listing_description_template", "刪除範本");
});

test("列表：排序是 sort_order, id（不是只有 id）", async () => {
  const exec = resetBoth();
  seedPair(exec, { id: 109, email: "t9@example.test" });
  // 免費上限是 2 則，要建到 3 筆才驗得出排序 ⇒ 用 sponsor（上限 5）。
  const opts = { plan: "sponsor" };
  for (const name of ["一", "二", "三"]) {
    sync.createDescriptionTemplate(db, 109, { name, body: `<p>${name}</p>` }, NOW, opts);
    await asyncMod.createDescriptionTemplateAsync(109, { name, body: `<p>${name}</p>` }, { now: NOW, ...PG, exec, ...opts });
  }
  // 手動把 sort_order 倒過來，排序才有鑑別力（照 id 排與照 sort_order 排會不同）。
  for (const h of [db, exec.raw]) h.prepare("UPDATE listing_description_template SET sort_order=? WHERE id=?").run(9, 1);
  const pg = await asyncMod.listDescriptionTemplatesAsync(109, { ...PG, exec });
  const lite = sync.listDescriptionTemplates(db, 109);
  assert.deepEqual(pg, lite);
  assert.deepEqual(pg.map((r) => r.id), [2, 3, 1], "sort_order=9 那一筆必須排到最後");
});

// ---------------------------------------------------------------------------
// 聯絡人

test("帳號聯絡人：第一次列出時自動建立，資料來自 users，形狀與同步版相同", async (t) => {
  // 同步版 `listContactProfiles(db, uid)` 沒有 `now` 參數（內部用 `new Date()`），
  // 所以只能**凍結時間**才比得出 `updated_at`。凍結的另外一個好處是：兩邊
  // 只要有一邊偷偷用了真實時間，這裡就會紅。
  t.mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
  const exec = resetBoth();
  seedPair(exec, {
    id: 201, email: "c1@example.test", nickname: "小明",
    lineId: "myline", contactPhone: "0912-345-678",
  });
  const pg = await asyncMod.listContactProfilesAsync(201, { ...PG, exec });
  const lite = sync.listContactProfiles(db, 201);
  assert.deepEqual(pg, lite, "整包必須相同");
  assert.equal(pg.length, 1);
  // `publicContact()` 把 is_account 轉成**布林**（`Number(row.is_account) === 1`），不是 0/1。
  assert.equal(pg[0].is_account, true);
  assert.equal(pg[0].locked, true);
  assert.equal(pg[0].label, lite[0].label, "label 必須相同（帳號聯絡人用的是顯示標籤）");
  assert.equal(pg[0].contact_name, "小明");
  assert.equal(pg[0].phone, lite[0].phone);
  assert.match(pg[0].line_url, /^https:\/\/line\.me\/ti\/p\//, "LINE 要正規化成網址（否則欄位是空的比對會假過）");
  assertSameRows(exec, "listing_contact_profile", "自動建立帳號聯絡人");
});

test("帳號聯絡人：重複呼叫不會生出第二筆（COALESCE 的 is_account 判斷）", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
  const exec = resetBoth();
  seedPair(exec, { id: 202, email: "c2@example.test", nickname: "小華" });
  for (let i = 0; i < 3; i += 1) {
    await asyncMod.listContactProfilesAsync(202, { ...PG, exec });
    sync.listContactProfiles(db, 202);
  }
  assert.equal(dump(exec.raw, "listing_contact_profile").length, 1, "PG 這邊不得重複建立");
  assert.equal(dump(db, "listing_contact_profile").length, 1, "同步版也不得重複建立");
});

test("帳號聯絡人：不可改、不可刪（403／account_contact_locked），兩邊一致", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
  const exec = resetBoth();
  seedPair(exec, { id: 203, email: "c3@example.test", nickname: "小美" });
  await asyncMod.listContactProfilesAsync(203, { ...PG, exec });
  sync.listContactProfiles(db, 203);
  const id = dump(exec.raw, "listing_contact_profile")[0].id;

  let syncUpd = null;
  try { sync.updateContactProfile(db, 203, id, { label: "改掉" }, LATER); } catch (e) { syncUpd = e; }
  await assert.rejects(() => asyncMod.updateContactProfileAsync(203, id, { label: "改掉" }, { now: LATER, ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncUpd));
  assert.equal(syncUpd?.status, 403);
  assert.equal(syncUpd?.code, "account_contact_locked", "code 也要相同（前端靠它判斷）");

  let syncDel = null;
  try { sync.deleteContactProfile(db, 203, id); } catch (e) { syncDel = e; }
  await assert.rejects(() => asyncMod.deleteContactProfileAsync(203, id, { ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncDel));
  assert.equal(dump(exec.raw, "listing_contact_profile").length, 1, "帳號聯絡人不得被刪掉");
});

test("手動聯絡人：上限 2 則（不含帳號聯絡人），第 3 則被擋下", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
  const exec = resetBoth();
  seedPair(exec, { id: 204, email: "c4@example.test" });
  for (const label of ["公司", "家人"]) {
    sync.createContactProfile(db, 204, { label, phone: "0912345678" }, NOW);
    await asyncMod.createContactProfileAsync(204, { label, phone: "0912345678" }, { now: NOW, ...PG, exec });
    sync.listContactProfiles(db, 204);
    await asyncMod.listContactProfilesAsync(204, { ...PG, exec });
  }
  let syncErr = null;
  try { sync.createContactProfile(db, 204, { label: "第三個", phone: "0912345678" }, NOW); } catch (e) { syncErr = e; }
  assert.ok(syncErr, "同步版應該擋下第 3 則");
  await assert.rejects(
    () => asyncMod.createContactProfileAsync(204, { label: "第三個", phone: "0912345678" }, { now: NOW, ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncErr),
    `PG 分支錯誤必須一致（同步版：${syncErr && reasonOf(syncErr)}）`,
  );
  // 帳號聯絡人 1 筆 ＋ 手動 2 筆 = 3 筆；被擋下的第 3 個手動聯絡人不得落地。
  assert.equal(dump(exec.raw, "listing_contact_profile").length, 3);
  assertSameRows(exec, "listing_contact_profile", "手動聯絡人上限");
});

test("聯絡人驗證：電話太短、缺 label、line_url 正規化，兩邊的錯誤與落地都相同", async () => {
  const exec = resetBoth();
  seedPair(exec, { id: 205, email: "c5@example.test" });
  const cases = [
    { input: { label: "公司", phone: "0912" }, why: "電話太短" },
    { input: { label: "   ", phone: "0912345678" }, why: "缺 label" },
  ];
  for (const c of cases) {
    let syncErr = null;
    try { sync.createContactProfile(db, 205, c.input, NOW); } catch (e) { syncErr = e; }
    assert.ok(syncErr, `同步版應該擋下（${c.why}）`);
    await assert.rejects(() => asyncMod.createContactProfileAsync(205, c.input, { now: NOW, ...PG, exec }),
      (e) => reasonOf(e) === reasonOf(syncErr), `PG 分支必須一致（${c.why}）`);
  }
  assert.equal(dump(exec.raw, "listing_contact_profile").length, 0, "被擋下的都不得落地");

  const ok = { label: "公司", phone: "0912-345-678", line_url: "https://line.me/ti/p/abc" };
  const pg = await asyncMod.createContactProfileAsync(205, ok, { now: NOW, ...PG, exec });
  const lite = sync.createContactProfile(db, 205, ok, NOW);
  assert.deepEqual(pg, lite);
  assert.equal(pg.phone, lite.phone);
  assert.equal(pg.is_account, false, "is_account 是布林 false（不是 0）");
  assert.equal(pg.locked, false);
  assert.ok(pg.label.length > 0, "label 不得為空，否則比對沒有鑑別力");
  assertSameRows(exec, "listing_contact_profile", "建立手動聯絡人");
});

test("更新手動聯絡人：只改帶到的欄位，沒帶的沿用舊值", async () => {
  const exec = resetBoth();
  seedPair(exec, { id: 206, email: "c6@example.test" });
  const input = { label: "公司", contact_name: "王先生", phone: "0912345678", line_url: "https://line.me/ti/p/xyz" };
  sync.createContactProfile(db, 206, input, NOW);
  const created = await asyncMod.createContactProfileAsync(206, input, { now: NOW, ...PG, exec });

  const pg = await asyncMod.updateContactProfileAsync(206, created.id, { phone: "0987654321" }, { now: LATER, ...PG, exec });
  const lite = sync.updateContactProfile(db, 206, created.id, { phone: "0987654321" }, LATER);
  assert.deepEqual(pg, lite);
  assert.equal(pg.phone, "0987654321");
  assert.equal(pg.label, "公司", "沒帶的 label 必須沿用舊值");
  assert.equal(pg.contact_name, "王先生", "沒帶的 contact_name 必須沿用舊值");
  assert.equal(pg.line_url, "https://line.me/ti/p/xyz", "沒帶的 line_url 必須沿用舊值");
  assert.equal(pg.updated_at, LATER.toISOString());
  assertSameRows(exec, "listing_contact_profile", "更新手動聯絡人");
});

test("聯絡人列表：帳號聯絡人排在最前面（COALESCE 的 DESC 排序）", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
  const exec = resetBoth();
  seedPair(exec, { id: 207, email: "c7@example.test", nickname: "本人" });
  sync.createContactProfile(db, 207, { label: "公司", phone: "0912345678" }, NOW);
  const manual = await asyncMod.createContactProfileAsync(207, { label: "公司", phone: "0912345678" }, { now: NOW, ...PG, exec });
  sync.listContactProfiles(db, 207);
  await asyncMod.listContactProfilesAsync(207, { ...PG, exec });
  assert.equal(manual.is_account, false, "這筆必須是手動的（id 較小）");

  const pg = await asyncMod.listContactProfilesAsync(207, { ...PG, exec });
  const lite = sync.listContactProfiles(db, 207);
  assert.deepEqual(pg, lite);
  assert.equal(pg.length, 2);
  assert.equal(pg[0].is_account, true, "帳號聯絡人必須排第一（即使它的 id 比較大）");
  assert.equal(pg[0].id, 2);
});

// ---------------------------------------------------------------------------
// schema／索引

// 記録用的假 pgDriver：只驗「做了什麼、順序、做幾次」，不執行 PG 語法。
function recordingDriver({ duplicates = [] } = {}) {
  const statements = [];
  return {
    statements,
    async exec(sql) { statements.push(sql); },
    async query(sql, params = []) {
      // 🚨 真的 `pgDriver.query()` **不翻譯** SQLite 方言 ⇒ 送進來的字串必須是 `$n`。
      // 這一條是後補的：memberMedia 的 live PG 測試炸出「dedupe 忘了 toPostgresSql」之後，
      // 回頭發現這裡也有同一個 bug，只是離線夾具從來沒有重複資料所以沒走到。
      if (sql.includes("?")) {
        throw new Error(`PG driver 收到未翻譯的 SQL（還有 ? 佔位符）：${sql.slice(0, 80)}`);
      }
      statements.push(sql);
      if (/HAVING COUNT/.test(sql)) return { rows: duplicates };
      if (/SELECT id FROM listing_contact_profile WHERE user_id=\$1/.test(sql)) return { rows: [{ id: 7 }] };
      return { rows: [] };
    },
  };
}

test("ensureListingToolsStoreOnce：先清重複、才建部分唯一索引，而且每個 driver 只做一次", async () => {
  const driver = recordingDriver({ duplicates: [{ user_id: 5 }, { user_id: 6 }] });
  await asyncMod.ensureListingToolsStoreOnce(driver);
  const first = [...driver.statements];
  assert.equal(driver.statements.filter((s) => s === asyncMod.PG_CREATE_ACCOUNT_INDEX_SQL).length, 1,
    "部分唯一索引必須被建立（正式站沒有這個索引，不建就擋不住第二筆帳號聯絡人）");
  const dupeAt = first.findIndex((s) => /HAVING COUNT/.test(s));
  const indexAt = first.findIndex((s) => /CREATE UNIQUE INDEX/.test(s));
  assert.ok(dupeAt >= 0 && indexAt > dupeAt,
    `索引必須在建之前先把重複清掉（有重複時 CREATE UNIQUE INDEX 會直接失敗）。順序：${first.map((s) => s.slice(0, 40))}`);
  // 有重複的 user 要**各清一次**：只清一個的話，另一個的重複資料會讓
  // `CREATE UNIQUE INDEX` 直接失敗（整個 schema bootstrap 就掛了）。
  const dropped = first.filter((s) => /^DELETE FROM listing_contact_profile/.test(s));
  assert.equal(dropped.length, 2, `兩個有重複的 user 都要各清一次，實際 ${dropped.length} 次`);
  assert.ok(first.some((s) => /ADD COLUMN IF NOT EXISTS is_account/.test(s)), "is_account 的 ALTER 也要跑");

  await asyncMod.ensureListingToolsStoreOnce(driver);
  assert.equal(driver.statements.length, first.length, "第二次呼叫不得再跑一次 schema");
});

test("夾具本身要真的拒絕 IFNULL／GROUP_CONCAT／LIMIT -1（否則方言守衛是空的）", async () => {
  const exec = pgFixture();
  await assert.rejects(() => exec("SELECT IFNULL(is_account,0) FROM listing_contact_profile"), /function ifnull/);
  await assert.rejects(() => exec("SELECT GROUP_CONCAT(label) FROM listing_contact_profile"), /group_concat/);
  await assert.rejects(() => exec("SELECT label FROM listing_contact_profile LIMIT -1"), /LIMIT must not be negative/);
  await assert.doesNotReject(() => exec("SELECT COALESCE(is_account,0) AS a FROM listing_contact_profile"), "COALESCE 必須放行");
});

test("PG 分支的語句不得出現 IFNULL（同步版有，PG 沒有）", async () => {
  const sqls = Object.entries(asyncMod).filter(([k, v]) => k.endsWith("_SQL") && typeof v === "string");
  assert.ok(sqls.length >= 15, `應該要抓到整組語句常數，實際 ${sqls.length} 條`);
  const bad = sqls.filter(([, sql]) => /\bIFNULL\s*\(/i.test(sql)).map(([k]) => k);
  assert.deepEqual(bad, [], `PG 分支的語句不得使用 IFNULL：${bad.join(", ")}`);
  const listContacts = asyncMod.LIST_CONTACTS_SQL;
  assert.match(listContacts, /COALESCE\(is_account,0\) DESC/, "排序那一句要保留 DESC（拿掉排序就失去意義）");
});

test("非 postgres 模式必須回退同步路徑（讀寫磁碟，不碰傳入的 exec）", async () => {
  const exec = resetBoth();
  seedPair(exec, { id: 301, email: "s1@example.test" });
  const pgItem = await asyncMod.createDescriptionTemplateAsync(301, { name: "夾具版", body: "<p>f</p>" }, { now: NOW, ...PG, exec });
  assert.equal(pgItem.name, "夾具版");

  const lite = await asyncMod.createDescriptionTemplateAsync(301, { name: "磁碟版", body: "<p>d</p>" }, { now: NOW, driver: "sqlite", exec });
  assert.equal(lite.name, "磁碟版", "sqlite 模式必須寫磁碟");
  assert.equal(dump(db, "listing_description_template").length, 1);
  assert.equal(dump(db, "listing_description_template")[0].name, "磁碟版");
  assert.equal(dump(exec.raw, "listing_description_template").length, 1, "sqlite 模式不得改動 PG 夾具");
  assert.equal(dump(exec.raw, "listing_description_template")[0].name, "夾具版");
});

test("strict：PG 寫入失敗時必須往上丟，不得無聲寫進沒人讀的 SQLite", async () => {
  const exec = resetBoth();
  seedPair(exec, { id: 302, email: "s2@example.test" });
  const broken = async () => { throw new Error("connection terminated unexpectedly"); };
  await assert.rejects(
    () => asyncMod.createDescriptionTemplateAsync(302, { name: "x", body: "<p>x</p>" }, { now: NOW, ...PG, exec: broken, strict: true }),
    /connection terminated/,
  );
  // 預設（非 strict）是 write fail-closed：一樣要丟，只是理由不同。
  await assert.rejects(
    () => asyncMod.createDescriptionTemplateAsync(302, { name: "x", body: "<p>x</p>" }, { now: NOW, ...PG, exec: broken }),
    /connection terminated/,
  );
  assert.equal(dump(db, "listing_description_template").length, 0, "寫入失敗不得回退寫 SQLite");
});
