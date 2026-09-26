import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'prb-parity-'));
process.env.DATA_DIR = dataDir;
// Match the production driver during live tests, including startup scheduling.
if (process.env.PG_TEST_URL) process.env.DB_DRIVER = 'postgres';
const app = await import('../src/db.js');
const {searchListingsAsync} = await import('../src/listingSearchAsync.js');
const {AS_OF, BASE, KEY, SETTINGS, DISTRICTS, args, seedBase, seedListing, withPgFixture, withoutSqliteIO} = await import('./fixtures/prb-search.mjs');
const db = app.sqliteHandle();
const skip = process.env.PG_TEST_URL ? false : 'PG_TEST_URL not set; covered by the PG integration job';
after(() => rmSync(dataDir, {recursive:true, force:true}));
beforeEach(() => {
  for (const table of ['user_listing_flags','user_same_house_members','user_match_votes','listing_group_members','listing_search_projection','listings','route_cache']) db.exec(`DELETE FROM ${table}`);
  db.exec('DELETE FROM users WHERE id IN (101,202)');
  seedBase(db);
});

test('nonempty PG provider pipeline decorates cards without any SQLite access, including MRT settings', async () => {
  const raw = db.prepare('SELECT * FROM listings ORDER BY post_id').all();
  const provider = app.preloadedDecorationProvider({now:Date.parse(AS_OF),systemCrawl:{showMrt:false}});
  const {result,attempts} = await withoutSqliteIO(db, async () => {
    const rows = app.buildListListingsRows(raw,{filter:'all',sort:'newest',uid:0,voteUid:0,
      kind:'',sources:'',settings:SETTINGS,districtSet:new Set(DISTRICTS),provider,flagMap:new Map(),requireProvider:true});
    return app.decorateListListingsPage(rows,raw,{settings:SETTINGS,provider,requireProvider:true});
  });
  assert.deepEqual(attempts,[]);
  assert.equal(result.length,3);
  assert.equal(result[0].mrt_station,null);
});
function ids(result) {
  assert.ok(Array.isArray(result.listings));
  assert.ok(Number.isInteger(result.totalMatched));
  return result.listings.map(row => Number(row.post_id) - BASE);
}
function cards(result) {
  return result.listings.map(r => ({id:Number(r.post_id), viewed:Number(r.viewed)||0, watched:Number(r.watched)||0,
    hidden:Number(r.hidden)||0, role:r.same_house_role||'', primary:Number(r.same_house_primary_id)||0,
    bundle:r.same_house?.primary_id||0, source_enabled:r.source_enabled, fit:r.fit_score, commute:r.commute_km}));
}
async function pgSearch(driver, input) {
  const {result, attempts} = await withoutSqliteIO(db, () => searchListingsAsync(input, {driver:'postgres', pgDriver:driver}));
  assert.deepEqual(attempts, [], 'complete PG search must make zero SQLite I/O attempts');
  assert.equal(result.queryDetails.engine, 'node_pg');
  assert.equal(result.queryDetails.asOf, input.asOf);
  return result;
}
test('SQLite dispatcher: complete projection yields both nonempty pages', async () => {
  const first = await searchListingsAsync(args(), {driver:'sqlite'});
  const second = await searchListingsAsync(args({offset:2}), {driver:'sqlite'});
  assert.equal(first.queryDetails.sql_first, true);
  assert.deepEqual(ids(first), [1,2]);
  assert.deepEqual(ids(second), [3]);
  assert.equal(first.totalMatched, 3);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
});
test('live PG: canonical fields, Node reference and SQLite dispatcher agree across both pages', {skip}, async () => {
  await withPgFixture(db, async driver => {
    const columns = 'post_id,source,source_key,search_key,title,url,first_seen_at,last_seen_at,offline';
    const pgRows = (await driver.query(`SELECT ${columns} FROM listings ORDER BY post_id`)).rows;
    const localRows = db.prepare(`SELECT ${columns} FROM listings ORDER BY post_id`).all();
    assert.deepEqual(pgRows.map(r=>({...r})), localRows.map(r=>({...r})), 'all canonical fixture fields, not only counts');
    const seen = [];
    for (const offset of [0,2]) {
      const input = args({offset});
      const pg = await pgSearch(driver,input);
      const ref = app.listListings(input);
      const dispatch = await searchListingsAsync(input,{driver:'sqlite'});
      assert.deepEqual(ids(pg), offset ? [3] : [1,2]);
      assert.deepEqual(ids(pg), ids(ref));
      assert.deepEqual(ids(pg), ids(dispatch));
      assert.deepEqual(cards(pg),cards(ref));
      for (const row of [pg,ref,dispatch]) {
        assert.equal(row.totalMatched,3);
        assert.equal(row.hasMore,offset===0);
        assert.equal(row.nextOffset,offset+2);
      }
      seen.push(...ids(pg));
    }
    assert.deepEqual(seen,[1,2,3]);
    console.log('PARITY-BASELINE', JSON.stringify({engines:['node_pg','node_sqlite','sql_first'], ids:seen, sqliteAttempts:0}));
  });
});
function seedRelations() {
  seedListing(db,4,{price_num:20000,price:'20000元',match_post_id:BASE+5,match_level:'high',refresh_time:'1小時前'});
  seedListing(db,5,{source_key:'1|3',price_num:20000,price:'20000元',match_post_id:BASE+4,match_level:'high',refresh_time:'2026-09-25T22:30:00.000Z'});
  seedListing(db,6,{source:'sinyi'});
  db.prepare('INSERT INTO user_listing_flags(user_id,post_id,watched) VALUES (101,?,1)').run(BASE+2);
  db.prepare('INSERT INTO user_listing_flags(user_id,post_id,hidden) VALUES (101,?,1)').run(BASE+3);
  db.prepare('INSERT INTO user_listing_flags(user_id,post_id,viewed) VALUES (202,?,1)').run(BASE+1);
  for (const id of [1,6]) db.prepare('INSERT INTO user_same_house_members(user_id,group_key,post_id,created_at) VALUES (202,?,?,?)').run('prb-personal',BASE+id,AS_OF);
}
test('fixed request time changes the expected primary and card bundle independently of wall time', t => {
  seedRelations();
  t.mock.method(Date,'now',()=>Date.parse('2099-01-01T00:00:00Z'));
  const at = app.listListings(args({limit:20}));
  assert.deepEqual(ids(at),[1,2,3,4,6]);
  const primary = at.listings.find(r=>r.post_id===BASE+4);
  assert.equal(primary.same_house_role,'primary');
  assert.equal(primary.same_house.primary_id,BASE+4);
  assert.equal(primary.same_house.compare.ids[0],BASE+4);
  const before = app.listListings(args({limit:20,asOf:'2026-09-25T00:00:00.000Z'}));
  assert.deepEqual(ids(before),[1,5,2,3,6]);
  assert.equal(before.listings.find(r=>r.post_id===BASE+5).same_house.primary_id,BASE+5);
  assert.equal(before.listings.find(r=>r.post_id===BASE+5).same_house.compare.ids[0],BASE+5);
});
const MATRIX = [
      ['baseline',{},[1,2,3,4,6]],
      ['viewer vs voter',{userId:101,matchVoteUserId:202},[1,4]],
      ['watched',{filter:'watched',userId:101,matchVoteUserId:202,districts:['不存在區']},[2]],
      ['hidden',{filter:'hidden',userId:101,matchVoteUserId:202},[3]],
      ['case insensitive q',{q:'pArK 1'},[1]],
      ['source',{sources:'sinyi'},[6]],
      ['area',{settings:{...SETTINGS,areaMax:11}},[1]],
      ['kind',{kind:'whole'},[1,2,3,4,6]],
      ['whole floor',{settings:{...SETTINGS,wholeFloorOnly:true}},[1,2,3,4,6]],
      ['extras',{settings:{...SETTINGS,priceMax:12000,priceMaxIncludesExtras:true}},[2]],
      ['fixed primary',{asOf:'2026-09-25T00:00:00.000Z'},[1,5,2,3,6]],
      ['fit',{sort:'fit_desc',q:'Park 1'},[1]],
    ];

test('reference fixture has explicit expected filters and personal roles', () => {
  seedRelations();
  db.prepare('UPDATE listings SET extra_fee=5000 WHERE post_id=?').run(BASE+1);
  for (const [name,extra,expected] of MATRIX) assert.deepEqual(ids(app.listListings(args({limit:20,...extra}))),expected,name);
});
test('live PG: relations, viewer/voter identity, filters, extras and time match the Node reference', {skip}, async () => {
  seedRelations();
  db.prepare('UPDATE listings SET extra_fee=5000 WHERE post_id=?').run(BASE+1);
  await withPgFixture(db, async driver => {
    const cases = MATRIX;
    for (const [name,extra,expected] of cases) {
      const input = args({limit:20,...extra});
      const ref = app.listListings(input);
      assert.deepEqual(ids(ref),expected,`${name}: independently expected reference ids`);
      const pg = await pgSearch(driver,input);
      assert.deepEqual(ids(pg),expected,name);
      assert.equal(pg.totalMatched,ref.totalMatched,name);
      assert.deepEqual(cards(pg),cards(ref),`${name}: role/bundle/flags/fit/commute`);
      if (name==='viewer vs voter') assert.equal(pg.listings[0].viewed,0,'flags belong to viewer 101, not voter 202');
    }
    // Settings omitted: the official default must load them from the same PG snapshot.
    const result = await pgSearch(driver,args({settings:undefined,limit:20}));
    assert.ok(ids(result).length>0);
    console.log('PARITY-MATRIX',JSON.stringify({cases:cases.length,sqliteAttempts:0}));
  });
});
test('live PG: commute preloading never warms SQLite', {skip}, async () => {
  const {makeRouteKey} = await import('../src/route.js');
  const settings={...SETTINGS,commuteKm:10,workLat:25.05,workLng:121.55,commuteMode:'scooter'};
  db.prepare("UPDATE listings SET lat=25.03,lng=121.53,geo_source='591',location_class='address' WHERE post_id=?").run(BASE+1);
  db.prepare('INSERT INTO route_cache(route_key,distances,min_km,updated_at,min_m) VALUES (?,?,?,?,?)').run(
    makeRouteKey(25.03,121.53,25.05,121.55,'scooter','to_work'),'[3]',3,AS_OF,3000);
  await withPgFixture(db,async driver=>{
    for (const sort of ['commute_asc','fit_desc']) {
      const input=args({settings,sort,limit:20,q:'Park 1'});
      const ref=app.listListings(input);
      const pg=await pgSearch(driver,input);
      assert.deepEqual(ids(ref),[1]);
      assert.deepEqual(ids(pg),[1]);
      assert.deepEqual(cards(pg),cards(ref));
    }
  });
});

test('live PG: a partner removed by profile filters still determines the shared house primary', {skip}, async () => {
  seedRelations();
  db.prepare('UPDATE listings SET area_name=? WHERE post_id=?').run('100坪',BASE+4);
  const input=args({limit:20,settings:{...SETTINGS,areaMax:20}});
  const reference=app.listListings(input);
  assert.deepEqual(ids(reference),[1,2,3,6]);
  await withPgFixture(db,async driver=>{
    const pg=await pgSearch(driver,input);
    assert.deepEqual(ids(pg),ids(reference));
    assert.deepEqual(cards(pg),cards(reference));
  });
});
test('live PG: missing required schema fails; existing empty tables return a normal empty result', {skip}, async () => {
  await withPgFixture(db,async driver=>{
    await driver.query('DELETE FROM listings');
    const empty=await pgSearch(driver,args());
    assert.deepEqual(ids(empty),[]);
    assert.equal(empty.totalMatched,0);
    for (const table of ['settings','users','user_settings','crawl_covers','listings']) {
      await driver.query(`ALTER TABLE ${table} RENAME TO missing_${table}`);
      try {
        await assert.rejects(()=>withoutSqliteIO(db,()=>searchListingsAsync(args(),{driver:'postgres',pgDriver:driver})),
          e=>e.code==='SEARCH_UNAVAILABLE' && e.cause?.code==='42P01',table);
      } finally {await driver.query(`ALTER TABLE missing_${table} RENAME TO ${table}`);}
    }
  });
});
test('live PG: complete page and counters use one snapshot; next request sees committed changes', {skip}, async () => {
  const {loadListingPage}=await import('../src/listingSearchPage.js');
  await withPgFixture(db,async driver=>{
    let connects=0, changed=false;
    const statements=[];
    const tracked={query:()=>{throw new Error('page escaped its snapshot');},pool:{connect:async()=>{
      connects++;
      const client=await driver.pool.connect();
      return {release:(...a)=>client.release(...a),query:async(sql,params)=>{
        statements.push(sql);
        if(!changed && /\bSELECT post_id, source/i.test(sql)) {
          changed=true;
          await driver.query(`INSERT INTO listings(post_id,source,source_key,search_key,title,url,price,price_num,first_seen_at,last_seen_at,offline,floor_name,area_name)
            SELECT $1,source,source_key,search_key,'New arrival','https://example.test/new',price,price_num,first_seen_at,last_seen_at,offline,floor_name,area_name FROM listings WHERE post_id=$2`,[BASE+20,BASE+1]);
        }
        return client.query(sql,params);
      }};
    }}};
    const {result:page,attempts}=await withoutSqliteIO(db,()=>loadListingPage(args(),{driver:'postgres',pgDriver:tracked}));
    assert.deepEqual(attempts,[]);
    assert.equal(changed,true,'external write ran during the candidate read');
    assert.equal(connects,1);
    assert.equal(statements.filter(sql=>/^BEGIN/.test(sql)).length,1);
    assert.equal(statements.filter(sql=>/^ROLLBACK/.test(sql)).length,1);
    assert.equal(page.stats.matched,3);
    assert.equal(page.stats.total,3,'counter stays on the pre-insert snapshot');
    const {result:next,attempts:nextAttempts}=await withoutSqliteIO(db,()=>loadListingPage(args(),{driver:'postgres',pgDriver:driver}));
    assert.deepEqual(nextAttempts,[]);
    assert.equal(next.stats.matched,4);
    assert.equal(next.stats.total,4);
  });
});

test('live PG: anonymous search preserves guest filters and never reads private flags or SQLite', {skip}, async () => {
  const {searchPublicListingsAsync} = await import('../src/publicListingSearchAsync.js');
  db.prepare('INSERT INTO user_listing_flags(user_id,post_id,hidden,watched,viewed,watch_note) VALUES (?,?,?,?,?,?)')
    .run(101,BASE+1,1,1,1,'private-only-keyword');
  await withPgFixture(db,async driver => {
    const cases = [
      [{},[1,2,3]], [{offset:2,limit:2},[3]], [{q:'park 1'},[1]],
      [{q:'private-only-keyword'},[]], [{districts:[DISTRICTS[1]]},[3]],
      [{sources:'591'},[1,2,3]], [{priceMax:11500},[1]],
      [{sort:'fit_desc'},[1,2,3]],
    ];
    for (const [query, expected] of cases) {
      const input = {sort:'newest',limit:50,...query,userId:101,matchVoteUserId:101,asOf:AS_OF};
      input.settings=app.publicSearchSettings(input);
      const reference=app.listPublicListings(input);
      const {result,attempts}=await withoutSqliteIO(db,()=>searchPublicListingsAsync(input,{driver:'postgres',pgDriver:driver}));
      assert.deepEqual(attempts,[]);
      assert.deepEqual(ids(result),expected,JSON.stringify(query));
      assert.deepEqual(ids(result),ids(reference));
      assert.deepEqual(cards(result),cards(reference));
      assert.equal(result.totalMatched,reference.totalMatched);
      assert.ok(result.listings.every(row=>!row.mine&&!row.watch_note&&!row.viewed&&!row.watched));
    }
    // PG-only data appears even when the SQLite store is deliberately different.
    await driver.query('UPDATE listings SET title=$1 WHERE post_id=$2',['PG-only-visible',BASE+1]);
    const {result,attempts}=await withoutSqliteIO(db,()=>searchPublicListingsAsync({q:'PG-only-visible',asOf:AS_OF},{driver:'postgres',pgDriver:driver}));
    assert.deepEqual(attempts,[]);
    assert.deepEqual(ids(result),[1]);
  });
});


test('cooperative member processing preserves roles, all sort modes and statistics across chunk boundaries', async () => {
  const template = db.prepare('SELECT * FROM listings ORDER BY post_id LIMIT 1').get();
  const raw = Array.from({length:1057},(_,i)=>({...template,post_id:BASE+i+1,
    price_num:i%13?10000+i%99:null, source_id:String(BASE+i+1),
    match_post_id:i===255?BASE+257:0,match_level:i===255?'high':'',
    first_seen_at:new Date(Date.parse(AS_OF)-i*60000).toISOString()}));
  const provider=app.preloadedDecorationProvider({now:Date.parse(AS_OF)});
  const options={filter:'all',kind:'',sources:'',sort:'newest',uid:101,voteUid:202,
    settings:SETTINGS,districtSet:new Set(),provider,flagMap:new Map(),requireProvider:true,now:Date.parse(AS_OF)};
  const reference=app.buildListListingsRows(structuredClone(raw),options);
  const {result,attempts}=await withoutSqliteIO(db,async()=>{
    const rows=await app.buildListListingsRowsAsync(structuredClone(raw),options);
    assert.deepEqual(rows,reference);
    for(const sort of ['newest','price_asc','price_desc','commute_asc','commute_desc','fit_desc']) {
      const expected=app.paginateListListingsRows(reference,{...options,sort,offset:250,limit:500});
      assert.deepEqual(await app.paginateListListingsRowsAsync(rows,{...options,sort,offset:250,limit:500}),expected);
    }
    const statsInput={rows:structuredClone(raw),flagMap:new Map(),userId:101,settings:SETTINGS,provider};
    const profile=await app.buildListingStatsRowsAsync(statsInput);
    assert.deepEqual(profile,app.buildListingStatsRows({...statsInput,rows:structuredClone(raw)}));
    const counters={profileRows:profile,settings:SETTINGS,provider,watchedTotal:19,
      statusCounts:{pending:7,confirmed:11},dbTotal:120000,failedRouteJobs:new Set()};
    assert.deepEqual(await app.summarizeListingStatsAsync(counters),app.summarizeListingStats(counters));
    return rows;
  });
  assert.deepEqual(attempts,[]);
  assert.equal(result.length,1056,'a pair straddling chunk 256 still has one primary');
});

test('live PG: batched snapshot reads bind parameters, retain all rows, and recover after failure', {skip}, async()=>{
  const {withPgReadSnapshot,readPgRows}=await import('../src/pgReadSnapshot.js');
  await withPgFixture(db,async driver=>{
    const previousJit=(await driver.query('SHOW jit')).rows[0].jit;
    const rows=await withPgReadSnapshot(driver,async snapshot=>{
      assert.equal((await snapshot.query('SHOW jit')).rows[0].jit,'off');
      return readPgRows(snapshot,
      'SELECT i FROM generate_series(1,1059) i WHERE i > $1 ORDER BY i',[2]);
    });
    assert.equal((await driver.query('SHOW jit')).rows[0].jit,previousJit);
    assert.deepEqual(rows.map(r=>r.i),Array.from({length:1057},(_,i)=>i+3));
    await assert.rejects(withPgReadSnapshot(driver,snapshot=>readPgRows(snapshot,'SELECT * FROM missing_required_table')),
      e=>e.code==='42P01');
    const next=await withPgReadSnapshot(driver,snapshot=>readPgRows(snapshot,'SELECT 42 AS n'));
    assert.deepEqual(next,[{n:42}]);
    assert.equal((await driver.query('SHOW jit')).rows[0].jit,previousJit);
  });
});


test('SQLite guard records swallowed cached-statement I/O, then restores the statement',async()=>{
  const cached=db.prepare('SELECT 42 AS n');
  const {attempts}=await withoutSqliteIO(db,async()=>{try{cached.get();}catch{ /* simulate a hidden fallback */ }});
  assert.deepEqual(attempts,[{method:'statement.get',sql:'<previously prepared>'}]);
  assert.equal(cached.get().n,42);
});
