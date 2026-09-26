import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresDriver } from '../src/dbDriverPostgres.js';
import { LIST_CANDIDATE_KEYS } from '../src/listingCandidateRow.js';
import { withPgReadSnapshot, readPgRows } from '../src/pgReadSnapshot.js';

const connectionString = process.env.PG_TEST_URL || '';
test('live PG: candidate array batches preserve every row, field, numeric value and text',
  { skip: !connectionString && 'PG_TEST_URL is not set' }, async () => {
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
  { skip: !connectionString && 'PG_TEST_URL is not set' }, async () => {
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
