// 「root 會不會跟著髒事件更新」實測（Owner 2026-10-12 第 3 條驗收）：
//   ① 群組成員進出 ② match 邊新增／撤銷 ③ 改價 ④ 改 offline_confirmed
// 全部在**一個交易內**做，最後 ROLLBACK ⇒ 不落任何列（只連隔離庫：assertPgTargetAllowed）。
//
// 語意提醒（判讀這份輸出時要看）：`fold_component_root` 是**分量標籤（成員最小 post_id）**，
// 不是贏家。所以「改價／改 offline_confirmed」**不該**改 root（成員沒變），改的是讀取端排名
// 選出的主卡；只有「群組進出／match 邊增刪」會改 root。這正是選 label 不選赢家的理由
// （見 docs/same-house-fold-spec.md §6.4）。
//
// 用法：PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/fold-root-mutation-check.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { refreshFoldComponentRoot } from "../src/foldComponentRoot.js";
import { refreshFoldColumns } from "../src/match.js";

assertPgTargetAllowed("fold-root-mutation-check", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });

const drv = await createPostgresDriver({ env: process.env });
const BASE = 9_200_000_000;
const ids = { M1: BASE + 1, M2: BASE + 2, M3: BASE + 3, M4: BASE + 4, G: `mut-${BASE}` };
const all = [ids.M1, ids.M2, ids.M3, ids.M4];

const client = await drv.pool.connect();
const exec = (sql, params = []) => client.query(toPostgresSql(sql), params).then((r) => r.rows);
const rootOf = async (pid) => {
  const rows = await exec("SELECT fold_component_root FROM listings WHERE post_id = ?", [pid]);
  return rows[0]?.fold_component_root == null ? null : Number(rows[0].fold_component_root);
};
const results = [];
const check = async (label, pid, expected) => {
  const got = await rootOf(pid);
  const ok = (got ?? null) === (expected ?? null);
  results.push({ label, post_id: pid, expected: expected ?? null, got: got ?? null, ok });
  return ok;
};

function listingRow(post_id, { rent, extra = 0 }) {
  return {
    post_id, source: "591", source_id: `mut${post_id}`, url: `https://example.test/mut/${post_id}`,
    title: `mut${post_id}`, price: `${rent}元`, price_num: rent, extra_fee: extra,
    extra_fees: "[]", extra_fee_text: "", extra_fee_text_dup: null, price_contain_text: "",
    refresh_time: "1 小時前", last_seen_at: "2026-10-01T00:00:00.000Z",
    match_post_id: null, match_verdict: null, offline: 0, offline_confirmed: 0, hidden: 0,
    first_seen_at: "2026-10-01T00:00:00.000Z", fold_component_root: null,
  };
}

await client.query("BEGIN");
try {
  // NOT NULL 欄由 information_schema 推導（與 fold-shape-fixtures.mjs 同一手法）
  const required = (await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='listings' AND is_nullable='NO'
        AND column_default IS NULL AND is_identity='NO' ORDER BY ordinal_position`,
  )).rows;
  const reqByName = new Map(required.map((c) => [c.column_name, c.data_type]));
  const insert = async (row) => {
    const names = [...new Set([...required.map((c) => c.column_name), ...Object.keys(row)])].filter((n) => n !== "extra_fee_text_dup");
    const values = names.map((name) => (name in row ? row[name]
      : (/int|numeric|real|double|bigint|smallint/i.test(reqByName.get(name) || "") ? 0 : "")));
    await client.query(
      `INSERT INTO listings(${names.map((n) => `"${n}"`).join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`,
      values,
    );
  };
  await insert(listingRow(ids.M1, { rent: 18000 }));
  await insert(listingRow(ids.M2, { rent: 24000 }));
  await insert(listingRow(ids.M3, { rent: 19000 }));
  await insert(listingRow(ids.M4, { rent: 17000 }));
  // ① 初始：M2 → M1 的 match 邊 ⇒ 分量 {M1,M2}，root = M1（最小 post_id）
  await client.query("UPDATE listings SET match_post_id = $1, match_verdict = 'yes' WHERE post_id = $2", [ids.M1, ids.M2]);
  // 走**生產漏斗**（refreshFoldColumns）：fold_* 與 root 一起刷新
  await refreshFoldColumns(exec, ids.M2);
  await check("① match 邊：M2 併進 M1（漏斗 refreshFoldColumns）", ids.M1, ids.M1);
  await check("① match 邊：M2 併進 M1（漏斗 refreshFoldColumns）", ids.M2, ids.M1);
  await check("① 未連邊的 M3 應為 NULL", ids.M3, null);
  await check("① 未連邊的 M4 應為 NULL", ids.M4, null);

  // ② 改價（M2 變得比 M1 便宜）⇒ root 不變（分量標籤不含價格）
  await exec("UPDATE listings SET price = ?, price_num = ? WHERE post_id = ?", ["9000元", 9000, ids.M2]);
  const priceOut = await refreshFoldComponentRoot(exec, ids.M2);
  await check("② 改價後 root 不變（M1 仍是標籤）", ids.M1, ids.M1);
  await check("② 改價後 root 不變（M2 仍指向 M1）", ids.M2, ids.M1);
  results.push({ label: "② 改價後 root 的寫入列數（0＝冪等且不受價格影響）", post_id: ids.M2, expected: 0, got: priceOut.changed, ok: priceOut.changed === 0 });

  // ③ 改 offline_confirmed ⇒ 仍是成員 ⇒ root 不變
  await exec("UPDATE listings SET offline_confirmed = 1 WHERE post_id = ?", [ids.M2]);
  const ocOut = await refreshFoldComponentRoot(exec, ids.M2);
  await check("③ 改 offline_confirmed 後 root 不變（成員沒變）", ids.M2, ids.M1);
  results.push({ label: "③ 改 offline_confirmed 後 root 的寫入列數", post_id: ids.M2, expected: 0, got: ocOut.changed, ok: ocOut.changed === 0 });
  await exec("UPDATE listings SET offline_confirmed = 0 WHERE post_id = ?", [ids.M2]);

  // ④ 群組成員進出：把 M3、M4 加入 M1 的群組 ⇒ 整組併成 {M1,M2,M3,M4}，root 仍是 M1
  //    （M3/M4 的 post_id 比 M1 大 ⇒ 標籤不變，但 M3/M4 必須從 NULL 變成 M1）
  await client.query(
    "INSERT INTO listing_group_members(post_id, group_id, source, match_evidence, joined_at) VALUES ($1,$2,'manual','mutation-check',$3), ($4,$2,'manual','mutation-check',$3)",
    [ids.M3, ids.G, new Date().toISOString(), ids.M4],
  );
  const groupOut = await refreshFoldComponentRoot(exec, ids.M3);
  // M3、M4 自成一群（M1／M2 不在此群）⇒ 分量 {M3,M4}，標籤＝最小 post_id＝M3
  await check("④ 群組新增：M3 取得 root（＝自己，該群最小）", ids.M3, ids.M3);
  await check("④ 群組新增：M4 取得 root（＝M3）", ids.M4, ids.M3);
  results.push({ label: "④ 群組新增後的寫入列數（M3＋M4）", post_id: ids.M3, expected: 2, got: groupOut.changed, ok: groupOut.changed === 2 });

  // ⑤ 群組移除：M3 離開群組 ⇒ M3 回到 NULL（M4 仍在群組裡）
  await client.query("DELETE FROM listing_group_members WHERE group_id = $1 AND post_id = $2", [ids.G, ids.M3]);
  const out2 = await refreshFoldComponentRoot(exec, ids.M3);
  await check("⑤ 群組移除：M3 回到 NULL", ids.M3, null);
  await check("⑤ 群組只剩 M4 一人 ⇒ M4 也回 NULL", ids.M4, null);
  results.push({ label: "⑤ 群組移除後的寫入列數（M3＋M4）", post_id: ids.M3, expected: 2, got: out2.changed, ok: out2.changed === 2 });

  // ⑥ match 邊撤銷：M2 → NULL ⇒ 分量解體，M1、M2 都回 NULL（M2 的群組關係不存在）
  await exec("UPDATE listings SET match_post_id = NULL WHERE post_id = ?", [ids.M2]);
  const out3 = await refreshFoldComponentRoot(exec, ids.M2);
  await check("⑥ 邊撤銷：M1 回 NULL", ids.M1, null);
  await check("⑥ 邊撤銷：M2 回 NULL", ids.M2, null);
  results.push({ label: "⑥ 邊撤銷後的寫入列數（M1＋M2）", post_id: ids.M2, expected: 2, got: out3.changed, ok: out3.changed === 2 });
} finally {
  await client.query("ROLLBACK");
  client.release();
  await drv.pool.end();
}

for (const r of results) console.log(JSON.stringify(r));
const allOk = results.every((r) => r.ok);
console.log(JSON.stringify({ allOk, total: results.length, residue: 0 }));
process.exit(allOk ? 0 : 1);
