// 內容文件的 **live PG** 驗證（2026-09-27）。
//
// 這一支存在的唯一理由：**不可變性是靠 trigger 實作的，而 PG 的 trigger 語法與 SQLite
// 完全不同**。同步版是 `BEFORE UPDATE … WHEN OLD.status='published' AND (NEW.body IS NOT OLD.body …)
// BEGIN SELECT RAISE(ABORT, …) END;`——`IS NOT OLD.x` 與 `RAISE(ABORT)` **PG 都不接受**。
// 離線 parity 用的是記憶體 SQLite（跑的是 SQLite 那一版 trigger），所以它證明不了：
//
//   1. plpgsql 函式與 `CREATE TRIGGER … EXECUTE FUNCTION` 真的建得起來；
//   2. 建好之後**真的擋得住**「已發布文件被改本文」——這是業務規則，不是加固；
//   3. 改旗標（enabled／effective_until）**不會**被誤擋。
//
// 教訓來自同一輪的 memberMedia：離線測試證明「兩邊算出一樣的結果」，證明不了
// 「送進 PG 的東西合法／真的生效」。
//
// ⚠️ 安全設計照抄 reject-match-live-pg.test.js：**不吃 `PG_TEST_URL`**（本機那個就是正式站），
// 只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
import { test } from "node:test";
import assert from "node:assert/strict";

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫 5151_shadow 一律拒絕）`
    : false;

const stamp = "2026-06-01T00:00:00.000Z";

test("live PG：不可變 trigger 真的建得起來，而且真的擋得住已發布文件被改本文", { skip }, async () => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const asyncMod = await import("../src/contentDocumentsAsync.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = (sql, params = []) => pgDriver.query(sql, params).then((r) => r.rows);
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");
  assert.ok(ALLOWED_DB.has(who.db), `拒絕在 ${who.db} 上執行`);

  const TYPE = "registration_terms";
  const cleanup = async () => {
    await query("DELETE FROM content_document_events WHERE document_type=$1 AND actor_id=$2", [TYPE, 900000000301]).catch(() => {});
    await query("DELETE FROM content_documents WHERE document_type=$1 AND created_by=$2", [TYPE, 900000000301]).catch(() => {});
  };
  await cleanup();

  // 1) bootstrap：PG 專屬 DDL ＋ plpgsql 函式 ＋ CREATE TRIGGER 都要跑得起來。
  await asyncMod.ensureContentDocumentStoreOnce(pgDriver);

  // 2) trigger 真的存在（`pg_trigger`，排除內部 trigger）。
  const trg = await query("SELECT tgname FROM pg_trigger WHERE tgname='content_documents_immutable' AND NOT tgisinternal");
  assert.equal(trg.length, 1, "content_documents_immutable 必須存在");
  const fn = await query("SELECT proname FROM pg_proc WHERE proname='content_documents_immutable_fn'");
  assert.equal(fn.length, 1, "plpgsql 函式必須存在");
  assert.equal(await asyncMod.publishedDocumentIsImmutable(pgDriver), true);

  // 3) 島嶼入口在真 PG 上建立並發布一份文件。
  const now = new Date(stamp);
  const doc = await asyncMod.createDraftAsync(
    { document_type: TYPE, title: "live 條款", body: "live 本文", check_label: "我同意" },
    { pgDriver, driver: "postgres", actorId: 900000000301, now },
  );
  assert.ok(doc.id, "草稿必須落地");
  const published = await asyncMod.publishDocumentAsync(doc.id, { pgDriver, driver: "postgres", actorId: 900000000301, now });
  assert.equal(published.status, "published");

  // 4) 🚨 核心：直接對 PG 下 UPDATE，改已發布文件的本文 ⇒ 必須被 trigger 擋下。
  await assert.rejects(
    () => query("UPDATE content_documents SET body='偷改' WHERE id=$1", [doc.id]),
    /published_document_immutable/,
    "trigger 沒有擋下＝PG 上根本沒有這條業務規則",
  );
  // ⚠️ `version` 是 bigint：`SET version='x'` 會先撞型別錯誤（invalid input syntax for bigint），
  // 那就測不到 trigger 了。文字欄位用 'x'、數值欄位用 999。
  for (const [col, value] of [["title", "'x'"], ["check_label", "'x'"], ["content_hash", "'x'"], ["version", "999"]]) {
    await assert.rejects(
      () => query(`UPDATE content_documents SET ${col}=${value} WHERE id=$1`, [doc.id]),
      /published_document_immutable/,
      `${col} 也必須在不可變清單裡`,
    );
  }
  // 本文必須原封不動。
  const after = await query("SELECT body, title FROM content_documents WHERE id=$1", [doc.id]);
  assert.equal(after[0].body, "live 本文", "本文不得被改掉");
  assert.equal(after[0].title, "live 條款");

  // 5) 反向：改旗標**不能**被誤擋（否則整個後台就廢了）。
  await query("UPDATE content_documents SET enabled=0, effective_until='2026-12-31' WHERE id=$1", [doc.id]);
  const flagged = await query("SELECT enabled, effective_until FROM content_documents WHERE id=$1", [doc.id]);
  assert.equal(String(flagged[0].enabled), "0", "旗標必須改得動");
  assert.equal(flagged[0].effective_until, "2026-12-31");

  // 6) 島嶼入口走的是同一條路：改已發布文件的本文要被擋成 409，不是 DB 例外。
  await assert.rejects(
    () => asyncMod.updateDraftAsync(doc.id, { body: "透過島嶼偷改" }, { pgDriver, driver: "postgres", now }),
    (e) => e.status === 409,
    "島嶼入口必須先在應用層擋下（回 409），不要讓 DB 例外漏出去",
  );

  // 7) 讀得回來（證明資料真的在 PG，不是只在回傳值裡）。
  // ⚠️ 第 5 步把 enabled 設成 0 了，所以**它不該是生效版本**——生效的是這個隔離庫裡
  // 原本就有的那一版。第一版這裡斷言 `effective.id === doc.id`，紅了才發現是自己的期望錯誤
  // （而且那條斷言在「本來就有一版生效」的庫上永遠是錯的）。
  const direct = await asyncMod.getDocumentByIdAsync(doc.id, { pgDriver, driver: "postgres" });
  assert.equal(Number(direct.id), Number(doc.id), "用 id 直接讀必須讀得到剛寫進去那一筆");
  assert.equal(direct.body, "live 本文");
  const effective = await asyncMod.getEffectiveDocumentAsync(TYPE, { pgDriver, driver: "postgres", now });
  assert.notEqual(Number(effective?.id), Number(doc.id), "已停用的版本不得成為生效版本");
  // `rowToDoc()` 會把 enabled 轉成**布林**（不是 0/1）——本系列第 N 次踩到同一個形狀問題。
  assert.equal(direct.enabled, false, "旗標仍然是停用");

  await cleanup();
  const left = await query("SELECT COUNT(*)::int AS n FROM content_documents WHERE created_by=$1", [900000000301]);
  assert.equal(left[0].n, 0, "測試資料必須清乾淨");
});
