import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'prb-candidate-reuse-'));
process.env.DATA_DIR = dataDir;
const { loadSearchCandidateRows } = await import('../src/listingSearchNodePg.js');
after(() => rmSync(dataDir, { recursive: true, force: true }));
const built = { where: 'WHERE search_key = ?', params: ['member-scope'] };

test('list IDs determine membership and order even when counter candidates have a different scope', async () => {
  const retained = Object.freeze({ post_id: 1, title: 'shared row' });
  const outside = Object.freeze({ post_id: 4, title: 'counter-only row' });
  const calls = [];
  const driver = { readRows: async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT post_id FROM/.test(sql)) return [{ post_id: 1 }, { post_id: 2 }, { post_id: 3 }];
    assert.deepEqual(params, [[2, 3]]);
    return [{ post_id: 3, title: 'list-only row 3' }, { post_id: 2, title: 'list-only row 2' }];
  } };
  const rows = await loadSearchCandidateRows(driver, {
    candidateColumns: 'post_id, title', built, reusableCandidates: [outside, retained],
  });
  assert.deepEqual(rows.map(row => row.post_id), [1, 2, 3]);
  assert.equal(rows[0], retained);
  assert.equal(rows[1].title, 'list-only row 2');
  assert.match(calls[0].sql, /WHERE search_key = \$1 ORDER BY post_id/);
  assert.deepEqual(calls[0].params, ['member-scope']);
  assert.equal(calls.length, 2);
  assert.deepEqual(outside, { post_id: 4, title: 'counter-only row' });
});

test('an empty list remains empty even when the profile counters have candidates', async () => {
  let calls = 0;
  const rows = await loadSearchCandidateRows({ readRows: async () => { calls++; return []; } }, {
    candidateColumns: 'post_id, title', built, reusableCandidates: [{ post_id: 9 }],
  });
  assert.deepEqual(rows, []);
  assert.equal(calls, 1);
});

test('a missing row within the same snapshot fails instead of silently shortening the page', async () => {
  const driver = { readRows: async sql => /SELECT post_id FROM/.test(sql) ? [{ post_id: 1 }] : [] };
  await assert.rejects(loadSearchCandidateRows(driver, {
    candidateColumns: 'post_id, title', built, reusableCandidates: [],
  }), /candidate missing/);
});

test('standalone search still reads the full ordered candidate query', async () => {
  const expected = [{ post_id: 3, title: 'standalone' }];
  const driver = { readRows: async (sql, params, options) => {
    assert.match(sql, /SELECT post_id, title FROM listings WHERE search_key = \$1 ORDER BY post_id/);
    assert.deepEqual(params, ['member-scope']);
    assert.deepEqual(options, { arrayRows: true });
    return expected;
  } };
  assert.equal(await loadSearchCandidateRows(driver, { candidateColumns: 'post_id, title', built }), expected);
});
