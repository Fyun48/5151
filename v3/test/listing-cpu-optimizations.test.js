import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { candidateRowFromValues, LIST_CANDIDATE_KEYS } from '../src/listingCandidateRow.js';
import { overlayPersonal, overlayRowsPersonal } from '../src/personalFlags.js';
import { createAttributeFilter, passesAttributeFilters } from '../src/floors.js';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'prb-cpu-'));
process.env.DATA_DIR = dataDir;
const { sortListingsRows, sortListingsRowsAsync } = await import('../src/db.js');
after(() => rmSync(dataDir, { recursive: true, force: true }));

test('canonical personal overlay preserves all 42 typed fields and never changes shared candidates', () => {
  const values = LIST_CANDIDATE_KEYS.map((key, i) => `${i}:${key}`);
  const base = candidateRowFromValues(values);
  Object.assign(base, { post_id: 42, price_num: 25000.5, extra_fee: null, lat: NaN,
    lng: Infinity, contact_uid: 0, hidden: 1, hidden_at: 'system-hidden', match_verdict: '' });
  const flags = Object.freeze({ viewed: '1', watched: '1', hidden: '0', watch_note: '私人備註',
    viewed_at: 'viewed', watched_at: 'watched', hidden_at: 'personal-hidden' });
  const before = structuredClone(base);
  Object.freeze(base);
  for (const verdict of ['', 'yes', 'no', null]) {
    const raw = Object.freeze({ ...base, match_verdict: verdict });
    for (const personal of [undefined, {}, flags]) {
      const actual = overlayPersonal(raw, personal, { candidateShape: true });
      assert.deepEqual(actual, overlayPersonal(raw, personal));
      for (const key of LIST_CANDIDATE_KEYS) {
        assert.ok(Object.hasOwn(actual, key), `candidate field ${key}`);
        if (!['hidden', 'hidden_at'].includes(key)) assert.deepEqual(actual[key], raw[key]);
      }
      assert.notEqual(actual, raw);
      assert.equal(actual.hidden, verdict === 'yes' ? 1 : 0);
      assert.equal(actual.hidden_at, verdict === 'yes' ? 'system-hidden' : personal?.hidden_at || null);
    }
  }
  assert.deepEqual(base, before);
  const first = overlayRowsPersonal([base], new Map([[42, flags]]), { candidateShape: true })[0];
  const second = overlayRowsPersonal([base], new Map(), { candidateShape: true })[0];
  assert.equal(first.watched, 1);
  assert.equal(first.watch_note, '私人備註');
  assert.equal(second.watched, 0);
  assert.equal(second.watch_note, '');
  const decorated = { ...base, route_km: 2.25, source_updated_at: '2026-09-26', custom: 'retained' };
  assert.equal(overlayPersonal(decorated, flags).custom, 'retained');
  assert.equal(overlayPersonal(decorated, flags).route_km, 2.25);
  assert.equal(overlayPersonal(decorated, flags).source_updated_at, '2026-09-26');
});

test('prepared attribute filters retain keyword, agent, rent, fee, floor and area semantics per request', () => {
  const base = { price_num: 20000, price: '20,000元', extra_fee: 0, floor_name: '5/12',
    area_name: '20坪', title: '近捷運', address: '台北市中山區', contact_uid: 1 };
  const rows = [base,
    { ...base, title: 'Campus SUITE' },
    { ...base, address: '河岸測試路' },
    { ...base, contact_uid: '42' },
    { ...base, agency: 'Ace Agency' },
    { ...base, role_name: '委託仲介' },
    { ...base, price_num: 50000 },
    { ...base, price_num: 24000, extra_fee: 2000 },
    { ...base, floor_name: '2/4' },
    { ...base, area_name: '8坪' },
    { ...base, area_name: '80坪' },
    { ...base, floor_name: '', area_name: '' },
  ].map(Object.freeze);
  const settings = { priceMin: 15000, priceMax: 25000, priceMaxIncludesExtras: true,
    minBuildingFloors: 8, areaMin: 10, areaMax: 40,
    excludeKeywords: 'SUITE,河岸,suite,近', excludeAgents: 'AGENCY，仲介', excludeAgentIds: ['42', -1] };
  assert.deepEqual(rows.map(createAttributeFilter(settings)),
    [true, false, false, false, false, false, false, false, false, true, false, true]);
  for (const conf of [{}, settings, { ...settings, excludeKeywords: ['河岸', 'SUITE'] },
    { excludeAgentIds: [42] }, { excludeKeywords: '不存在' }, { areaMax: 15 },
    { priceMax: 25000, priceMaxIncludesExtras: false }]) {
    assert.deepEqual(rows.map(createAttributeFilter(conf)), rows.map(row => passesAttributeFilters(row, conf)));
  }
  const allowed = createAttributeFilter({});
  const excluded = createAttributeFilter({ excludeKeywords: 'SUITE' });
  assert.equal(excluded(rows[1]), false);
  assert.equal(allowed(rows[1]), true);
  assert.equal(excluded(rows[1]), false);
});

test('async scalar-key sorting keeps reference order, stable ties and row identity across chunks', async () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const dates = ['2026-09-01T00:00:00Z', '2026-09-20T00:00:00Z', '', 'invalid'];
  const rows = Array.from({ length: 1031 }, (_, i) => Object.freeze({
    post_id: i % 13, marker: i,
    price_num: [0, null, 18000, 25000.5, 3.8, NaN, -1][i % 7],
    price: i % 3 ? '' : '2.4萬', extra_fee: i % 5 ? 0 : 2500,
    extra_fees: i % 17 ? '[]' : '[{"name":"管理費","amount":1200}]',
    source_updated_at: i % 2 ? dates[i % 4] : '',
    source_published_at: i % 11 ? '' : dates[i % 4],
    refresh_time: i % 3 ? '1小時前' : dates[i % 4],
    first_seen_at: i % 19 ? dates[i % 4] : new Date(now - i * 1000).toISOString(),
    last_seen_at: '2026-09-26T11:00:00Z', watched_at: '2099-01-01',
    commute_km: [undefined, null, NaN, '', 0, 3.5, 2.1][i % 7],
    route_km: i % 5 ? 4.19 : undefined,
    fit_score: [undefined, null, NaN, 0, -1, 25, 82.5][i % 7],
  }));
  // Identical keys at different positions exercise stability across merge boundaries.
  rows[2] = Object.freeze({ ...rows[900], marker: 'earlier-tie' });
  const originalOrder = [...rows];
  for (const sort of ['newest', 'price_asc', 'price_desc', 'commute_asc', 'commute_desc', 'fit_desc', 'unknown']) {
    for (const priceMaxIncludesExtras of [false, true]) {
      const options = { now, settings: { priceMaxIncludesExtras } };
      const expected = sortListingsRows(rows, sort, options);
      const actual = await sortListingsRowsAsync(rows, sort, options);
      assert.deepEqual(actual.map(row => row.marker), expected.map(row => row.marker), sort);
      assert.equal(actual.length, rows.length);
      actual.forEach((row, i) => assert.equal(row, expected[i]));
      assert.ok(actual.indexOf(rows[2]) < actual.indexOf(rows[900]), `${sort} stable tie`);
    }
  }
  assert.deepEqual(rows, originalOrder);
  assert.deepEqual(await sortListingsRowsAsync([], 'newest', { now }), []);
  const special = [Infinity, -Infinity, NaN, null, 42].map((fit_score, i) => ({ post_id: i, fit_score }));
  assert.deepEqual(await sortListingsRowsAsync(special, 'fit_desc', { now }),
    sortListingsRows(special, 'fit_desc', { now }));
});
