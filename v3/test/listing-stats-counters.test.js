import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'prb-counter-contract-'));
process.env.DATA_DIR = dataDir;
const { summarizeListingStats, summarizeListingStatsAsync, summarizeRawListingStatsAsync,
  buildListingStatsRowsAsync, preloadedDecorationProvider } = await import('../src/db.js');
after(() => rmSync(dataDir, { recursive: true, force: true }));

const row = (post_id, extra = {}) => ({
  post_id, viewed: 0, watched: 0, hidden: 0, offline: 0, offline_confirmed: 0,
  match_level: '', match_verdict: '', last_event: 'new',
  title: '住宅', kind_name: '電梯大樓', address: '台北市', tags: '[]',
  geo_source: 'geocode', lat: 25.1, lng: 121.5, ...extra,
});
const rows = [
  row(1),
  row(2, { viewed: 1, last_event: 'update', lat: 25.2 }),
  row(3, { watched: 1, lat: null, lng: null }),
  row(4, { hidden: 1 }),
  row(5, { offline: 1, last_event: 'price_drop' }),
  row(6, { offline: 1, offline_confirmed: 1 }),
  row(7, { match_verdict: 'yes', hidden: 1 }),
  row(8, { match_level: 'high', geo_source: '', lat: null, lng: null }),
  row(9, { match_level: 'medium', match_verdict: 'no' }),
  row(10, { viewed: 1, route_kms: [2] }),
  row(11, { title: '無電梯住宅', geo_source: '' }),
  row(12, { watched: 1, offline: 1, offline_confirmed: 1 }),
];
const settings = { commuteKm: 5, commuteMode: 'scooter', workLat: 25.5, workLng: 121.6 };
const expected = {
  total: 7, unseen: 5, watched: 1, watchedTotal: 3, same_source: 2, hidden: 2,
  offline: 6, offlineConfirmed: 4, suspected: 2, suspectedPending: 1,
  elevator: 6, stored: 7, filteredOut: 0, missingGeo: 2, missingRoute: 1, dbTotal: 100,
};
const options = {
  profileRows: rows, settings, statusCounts: { pending: 6, confirmed: 4 },
  watchedTotal: 3, dbTotal: 100,
  failedRouteJobs: new Set(['9|to_work|distance|scooter|25.5,121.6']),
  provider: { routeCache: (a, b, c) => a === 25.2 || c === 25.2 ? { distances: [3] } : null },
};

test('counters preserve pending/offline, personal flags, geo, cached routes and failed jobs', async () => {
  assert.deepEqual(summarizeListingStats(options), expected);
  assert.deepEqual(await summarizeListingStatsAsync(options), expected);
});

test('disabled commute leaves route count zero and never reads the route provider', async () => {
  const actual = await summarizeListingStatsAsync({
    ...options, settings: { ...settings, commuteKm: 0 },
    provider: { routeCache: () => { throw new Error('commute is disabled'); } },
  });
  assert.deepEqual(actual, { ...expected, missingRoute: 0 });
});

test('chunked counters add row counts while preserving global totals once', async () => {
  const repetitions = 50; // 600 rows crosses both 256-row boundaries.
  const actual = await summarizeListingStatsAsync({
    ...options, profileRows: Array.from({ length: repetitions }, () => rows).flat(),
  });
  const global = new Set(['offline', 'offlineConfirmed', 'watchedTotal', 'dbTotal']);
  assert.deepEqual(actual, Object.fromEntries(Object.entries(expected)
    .map(([key, value]) => [key, global.has(key) ? value : value * repetitions])));
});

test('streaming raw counters preserve filtering, personal flags and totals across partial chunks', async () => {
  const {candidateRowFromValues,LIST_CANDIDATE_KEYS} = await import('../src/listingCandidateRow.js');
  const raw = Array.from({length:1031},(_,i)=>{
    const item={...rows[i%rows.length],post_id:i+1,source:'591',price_num:10000+i,
      price:String(10000+i),floor_name:'5/12',area_name:'20坪'};
    return Object.freeze(candidateRowFromValues(LIST_CANDIDATE_KEYS.map(key=>item[key] ?? null)));
  });
  const flags=new Map(raw.filter((_,i)=>i%7===0).map(r=>[r.post_id,{viewed:1,watched:r.post_id%2,hidden:r.post_id%3===0?1:0}]));
  for(const selected of [[],raw.slice(0,1),raw.slice(0,255),raw.slice(0,257),raw]) {
    for(const priceMin of [0,10500]) {
      const conf={...settings,commuteKm:0,priceMin};
      const provider=preloadedDecorationProvider({personalFlags:flags});
      const shared={...options,rows:selected,settings:conf,provider,flagMap:flags,userId:101,candidateShape:true};
      const profileRows=await buildListingStatsRowsAsync(shared);
      const expected=await summarizeListingStatsAsync({...shared,profileRows});
      const diagnostics={};
      assert.deepEqual(await summarizeRawListingStatsAsync(shared,diagnostics),expected);
      assert.equal(expected.dbTotal,100);
      assert.equal(expected.watchedTotal,3);
      assert.ok(diagnostics.reduce_ms>=0);
      assert.ok(diagnostics.profile_sync_ms>=0);
    }
  }
  assert.equal(raw.length,1031);
});
