import { randomUUID } from 'node:crypto';
import { createPostgresDriver } from '../../src/dbDriverPostgres.js';
import { importStore, createIndexStatements } from '../../src/pgSchema.js';
import { syncListingProjection } from '../../src/listingSearchProjection.js';
import { districtNameFromListing } from '../../src/regions.js';

export const AS_OF = '2026-09-26T00:00:00.000Z';
export const BASE = 900300000;
export const KEY = 'https://rent.591.com.tw/list?region=1&section=2%2C3';
export const DISTRICTS = ['1|2', '1|3'].map(source_key => districtNameFromListing({source_key}));
export const SETTINGS = {
  searchUrls: [KEY], excludeLowFloors: false, excludeRooftop: false,
  priceMin: 0, priceMax: 0, areaMax: 0, commuteKm: 0,
};
export const SEARCH_TABLES = [
  'settings', 'users', 'user_settings', 'crawl_covers', 'listings',
  'listing_search_projection', 'user_listing_flags', 'user_same_house_members',
  'user_match_votes', 'listing_group_members', 'listing_prep',
  'route_cache', 'mrt_cache', 'route_jobs',
];
export function seedListing(db, index, extra = {}) {
  const stamp = new Date(Date.parse(AS_OF) - index * 3600_000).toISOString();
  const row = {
    post_id: BASE + index, source: '591', source_id: String(BASE + index),
    source_key: index === 3 ? '1|3' : '1|2', search_key: KEY,
    title: `Park ${index}`, url: `https://example.test/prb/${index}`,
    price: `${10000 + index * 1000}元`, price_num: 10000 + index * 1000,
    address: `台北市${DISTRICTS[index === 3 ? 1 : 0]}測試路${index}號`,
    area_name: `${10 + index}坪`, floor_name: '5/12', kind_name: '整層住家/電梯大樓',
    tags: '[]', extra_fees: '[]', first_seen_at: stamp, last_seen_at: stamp,
    refresh_time: stamp, offline: 0, offline_confirmed: 0, hidden: 0,
    ...extra,
  };
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO listings (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
  const stored = db.prepare('SELECT * FROM listings WHERE post_id = ?').get(row.post_id);
  syncListingProjection(db, stored, Date.parse(AS_OF));
  return stored;
}
export function seedBase(db) {
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('crawlSources', JSON.stringify([{id:'591',enabled:true},{id:'sinyi',enabled:true}]));
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('searchUrls', JSON.stringify([KEY]));
  for (const id of [101, 202]) db.prepare('INSERT INTO users (id,email,created_at) VALUES (?,?,?)').run(id, `prb${id}@example.test`, AS_OF);
  return [1, 2, 3].map(i => seedListing(db, i));
}
export function args(extra = {}) {
  return { filter: 'all', sort: 'newest', limit: 2, offset: 0, userId: 0, matchVoteUserId: 0,
    searchKeys: [KEY], districts: DISTRICTS, settings: SETTINGS, asOf: AS_OF, ...extra };
}
export async function withPgFixture(db, fn, { tables = SEARCH_TABLES } = {}) {
  if (!process.env.PG_TEST_URL) throw new Error('PG_TEST_URL is required for an isolated fixture');
  const schema = `prb_${randomUUID().replaceAll('-', '')}`;
  const driver = await createPostgresDriver({ connectionString: process.env.PG_TEST_URL,
    poolOptions: { max: 6, options: `-c search_path=${schema}`, application_name: '5151-prb-fixture' } });
  try {
    await importStore(driver, db, { schema, tables, indexes: false });
    const sqliteOnly = /instr\s*\(|julianday\s*\(|strftime\s*\(|datetime\s*\(|date\s*\(|COLLATE\s+NOCASE|GLOB\b|printf\s*\(/i;
    for (const table of tables) for (const sql of createIndexStatements(db, table, {schema})) {
      if (!sqliteOnly.test(sql)) await driver.exec(sql);
    }
    return await fn(driver, schema);
  } finally {
    try { await driver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await driver.close(); }
  }
}

// Record attempts as well as throw: helpers must not be able to swallow an I/O
// error and make a false claim that PostgreSQL never touched SQLite.
export async function withoutSqliteIO(db, fn) {
  const original = new Map();
  const attempts = [];
  for (const method of ['prepare','exec']) {
    original.set(method, db[method]);
    db[method] = (...params) => {
      attempts.push({method, sql: String(params[0]).slice(0,180)});
      throw new Error(`Forbidden SQLite ${method}: ${String(params[0]).slice(0,100)}`);
    };
  }
  try { return { result: await fn(), attempts }; }
  finally { for (const [method, value] of original) db[method] = value; }
}
