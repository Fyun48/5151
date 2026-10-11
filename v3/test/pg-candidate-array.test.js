import { livePgTargetSkip } from "./helpers/livePgTarget.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresDriver } from '../src/dbDriverPostgres.js';
import { LIST_CANDIDATE_KEYS } from '../src/listingCandidateRow.js';
import { withPgReadSnapshot, readPgRows } from '../src/pgReadSnapshot.js';
import { createWorkDiagnostics, withWorkDiagnostics } from '../src/workDiagnostics.js';

const connectionString = process.env.PG_TEST_URL || '';
// ⚠️ 安全：PG_TEST_URL 在本機指向正式庫 5151_shadow，目標庫不在允許清單就整支 skip。
//    守衛必須在建立連線之前（見 v3/test/helpers/livePgTarget.js）。
const GUARD_SKIP = await livePgTargetSkip("pg-candidate-array");
test('live PG: narrow reads retain all rows across bounded replies and report batch work',
  { skip: GUARD_SKIP || (!connectionString && 'PG_TEST_URL is not set') }, async () => {
    const driver = await createPostgresDriver({ connectionString });
    const diagnostics = createWorkDiagnostics();
    try {
      await withWorkDiagnostics(diagnostics, () => withPgReadSnapshot(driver, async snapshot => {
        const rows = await readPgRows(snapshot, 'SELECT i::bigint AS post_id FROM generate_series(1,8705) i ORDER BY i');
        assert.deepEqual(rows.map(r => r.post_id), Array.from({length:8705}, (_,i) => i + 1));
      }));
      const metrics = diagnostics.snapshot();
      assert.equal(metrics['pg.appendRows.sync'].totalUnits, 8705);
      // 窄讀取（1 欄）的批次上限＝8,192 列（cell 預算不變）。8,705 列 ⇒
      // FETCH 512（暖身）→ FETCH 8192 → FETCH 1，共 3 趟、2 次 yield。
      assert.equal(metrics['pg.appendRows.sync'].maxUnits, 8192);
      assert.ok(metrics['pg.fetch.yieldWait'].calls >= 1);
      assert.ok(metrics['pg.fetch.wall'].calls >= 2);
    } finally { await driver.close(); }
  });
test('live PG: complete-read planner settings remain local after success and failure',
  { skip: GUARD_SKIP || (!connectionString && 'PG_TEST_URL is not set') }, async () => {
    const driver = await createPostgresDriver({ connectionString, poolOptions:{max:1} });
    const settings = "SELECT current_setting('jit') AS jit, current_setting('cursor_tuple_fraction') AS fraction";
    try {
      const before = (await driver.query(settings)).rows;
      const verify = async snapshot => {
        assert.deepEqual((await snapshot.query(settings)).rows, [{jit:'off',fraction:'1'}]);
      };
      await withPgReadSnapshot(driver, verify);
      assert.deepEqual((await driver.query(settings)).rows, before);
      await assert.rejects(withPgReadSnapshot(driver,async snapshot=>{
        await verify(snapshot); throw new Error('deliberate callback failure');
      }),/deliberate callback failure/);
      assert.deepEqual((await driver.query(settings)).rows,before);
    } finally { await driver.close(); }
  });
test('live PG: candidate array batches preserve every row, field, numeric value and text',
  { skip: GUARD_SKIP || (!connectionString && 'PG_TEST_URL is not set') }, async () => {
    const driver = await createPostgresDriver({ connectionString });
    try {
      await withPgReadSnapshot(driver, async snapshot => {
        const sql = `SELECT (900000000+i)::bigint AS post_id, $1::text AS title,
          'Infinity'::text AS price, '["電梯","停車位"]'::text AS tags,
          CASE i % 4 WHEN 0 THEN NULL WHEN 1 THEN 12345.5 ELSE -1 END::double precision AS price_num,
          CASE i % 4 WHEN 0 THEN 'NaN' WHEN 1 THEN 'Infinity' WHEN 2 THEN '-Infinity' ELSE '25.125' END::double precision AS lat,
          121.5::double precision AS lng, NULL::double precision AS extra_fee,
          (i % 2)::bigint AS hidden, NULL::text AS hidden_at
          FROM generate_series(1,1026) AS series(i) ORDER BY post_id`;
        const params = ['台北「住宅」 \\ "\n中文'];
        const original = await readPgRows(snapshot, sql, params);
        const candidate = await readPgRows(snapshot, sql, params, { arrayRows: true });
        assert.equal(candidate.length, 1026);
        assert.equal(candidate[0].post_id, 900000001);
        assert.equal(candidate.at(-1).post_id, 900001026);
        assert.deepEqual(candidate, original);
      });
    } finally { await driver.close(); }
  });

test('live PG: the complete candidate shape keeps the typed value in every named column',
  { skip: GUARD_SKIP || (!connectionString && 'PG_TEST_URL is not set') }, async () => {
    const driver = await createPostgresDriver({ connectionString });
    try {
      await withPgReadSnapshot(driver, async snapshot => {
        const columns = LIST_CANDIDATE_KEYS.map((key, index) => key === 'post_id'
          ? '(900000000+i)::bigint AS post_id'
          : `('${index}:' || i::text) AS ${key}`);
        const sql = `SELECT ${columns.join(', ')} FROM generate_series(1,1026) AS series(i) ORDER BY post_id`;
        const original = await readPgRows(snapshot, sql);
        const candidate = await readPgRows(snapshot, sql, [], { arrayRows: true });
        assert.equal(candidate.length, 1026);
        assert.deepEqual(candidate, original);
      });
    } finally { await driver.close(); }
  });
