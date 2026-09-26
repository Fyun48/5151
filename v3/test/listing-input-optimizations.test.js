import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync as Database } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPostgresDriver, numberFromPg } from '../src/dbDriverPostgres.js';
import { toPostgresSql } from '../src/sqlDialect.js';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'prb-inputs-'));
process.env.DATA_DIR = dataDir;
const { buildListListingsClauses, preloadDecorationProviderAsync, buildListListingsRowsAsync } = await import('../src/db.js');
const { normalizeStatsCandidateRow, STATS_CANDIDATE_NUMERIC_KEYS } = await import('../src/repository/listingStats.js');
after(() => rmSync(dataDir, {recursive:true, force:true}));
const context = {asOf:'2026-09-26T00:00:00Z', searchKeys:[], isolation:{sql:'1 = 1',params:[]},
  crawlSources:{items:[{id:'591',enabled:true},{id:'houseprice',enabled:true}]}, systemCrawl:{}};

function flagQuery(filter, uid, postgres) {
  const built = buildListListingsClauses({filter,uid,voteUid:uid === 101 ? 202 : 101,
    settings:{},districts:[],context}, postgres ? {sqliteDb:null} : {});
  const column = filter === 'all' ? 'watched' : 'viewed';
  const clause = built.clauses.find(sql => sql.includes('user_listing_flags') && new RegExp(`\\b${column}\\b`).test(sql));
  assert.ok(clause, `${filter} flag predicate from the production builder`);
  return {sql:`SELECT post_id FROM listings WHERE ${clause} ORDER BY post_id`,params:[uid]};
}
const flagValues = [[101,2,0],[101,3,1],[101,4,2],[101,5,-1],[101,6,null],
  [202,1,1],[202,2,1],[202,3,0],[202,6,1]];
const expectedFlags = (filter, uid) => filter === 'viewed'
  ? uid === 101 ? [3] : [1,2,6]
  : uid === 101 ? [1,2,6] : [3,4,5];
const flagSchema = 'CREATE TEMP TABLE listings(post_id BIGINT PRIMARY KEY); CREATE TEMP TABLE user_listing_flags(user_id BIGINT, post_id BIGINT, watched BIGINT, viewed BIGINT, PRIMARY KEY(user_id,post_id));';

test('flag existence predicates keep missing, zero, nonbinary, NULL and viewer identity semantics', () => {
  const db = new Database(':memory:');
  try {
    db.exec(flagSchema);
    for (let i=1;i<=6;i++) db.prepare('INSERT INTO listings VALUES (?)').run(i);
    for (const [uid,id,value] of flagValues) db.prepare('INSERT INTO user_listing_flags VALUES (?,?,?,?)').run(uid,id,value,value);
    for (const uid of [101,202]) for (const filter of ['all','unseen','viewed']) {
      for (const postgres of [false,true]) {
        const {sql,params} = flagQuery(filter,uid,postgres);
        assert.deepEqual(db.prepare(sql).all(...params).map(r=>r.post_id), expectedFlags(filter,uid));
      }
    }
  } finally { db.close(); }
});

test('live PG: production flag predicates match SQLite reference with nonbinary and NULL flags',
  {skip:!process.env.PG_TEST_URL && 'PG_TEST_URL is not set'}, async () => {
    const driver = await createPostgresDriver({connectionString:process.env.PG_TEST_URL,poolOptions:{max:1}});
    const client = await driver.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(flagSchema);
      await client.query('INSERT INTO listings SELECT generate_series(1,6)');
      for (const [uid,id,value] of flagValues) await client.query('INSERT INTO user_listing_flags VALUES ($1,$2,$3,$3)',[uid,id,value]);
      for (const uid of [101,202]) for (const filter of ['all','unseen','viewed']) {
        for (const postgres of [false,true]) {
          const {sql,params} = flagQuery(filter,uid,postgres);
          assert.deepEqual((await client.query(toPostgresSql(sql),params)).rows.map(r=>r.post_id), expectedFlags(filter,uid));
        }
      }
    } finally { await client.query('ROLLBACK');client.release();await driver.close(); }
  });

test('stats numeric normalization preserves the complete conversion and own-field contract', () => {
  for (const value of [0,1,-1,NaN,Infinity,null,undefined,'0','1','12345.5','NaN','Infinity','',true,false]) {
    const input = Object.fromEntries(STATS_CANDIDATE_NUMERIC_KEYS.map(key=>[key,value]));
    input.title = 'preserved';
    const expected = {...input};
    for (const key of STATS_CANDIDATE_NUMERIC_KEYS) if (value != null && typeof value !== 'number') expected[key] = numberFromPg(value);
    assert.equal(normalizeStatsCandidateRow(input), input);
    assert.deepEqual(input, expected);
  }
  const inherited = Object.create({post_id:'42'});
  inherited.title = 'not a canonical PG row';
  assert.equal(normalizeStatsCandidateRow(inherited).post_id, '42');
  assert.equal(Object.hasOwn(inherited,'post_id'), false);
  assert.deepEqual(normalizeStatsCandidateRow({}), {});
  assert.equal(normalizeStatsCandidateRow(null), null);
});

test('candidate prep retains houseprice and unknown peers, all candidates and personal relations', async () => {
  const rows = Array.from({length:1025},(_,i)=>({post_id:i+1,source:'591',source_key:'1|2',
    title:'住宅',price_num:20000+i,price:String(20000+i),extra_fees:'[]',floor_name:'5/12',area_name:'20坪',
    match_post_id:0,match_verdict:'',refresh_time:context.asOf,last_seen_at:context.asOf}));
  rows[0].match_post_id = 2000;
  rows[1].match_post_id = 2001;
  rows[2].source = 'houseprice';
  rows[2].match_post_id = 5;
  const external = new Map([2000,2001,2002].map(id=>[id,{...rows[0],post_id:id,source:'houseprice',price_num:10000,match_post_id:0}]));
  const personalIndex = {size:2,groupKey:id=>[4,2002].includes(Number(id))?'personal':'',
    peers:id=>Number(id)===4?[2002]:Number(id)===2002?[4]:[],agrees:()=>false};
  const prepare = async candidatePhase => {
    let requested;
    const loader = {personalFlagMap:async()=>new Map(),personalIndex:async()=>personalIndex,splitPairSet:async()=>new Set(),
      prepMap:async ids=>{requested=ids;return new Map(ids.map(id=>[id,{post_id:id,display_ready:id===2001?0:1}]));},
      extrasMap:async ids=>new Map(ids.map(id=>[id,external.get(id)])),
      routeCacheMap:async()=>new Map(),mrtCacheMap:async()=>new Map(),routeJobsMap:async()=>new Map()};
    const provider = await preloadDecorationProviderAsync({exec:async()=>{throw new Error('unexpected fallback');},loader,rows,
      settings:{},userId:101,matchVoteUserId:202,peers:false,candidatePhase,requestContext:context});
    return {provider,requested};
  };
  const all = await prepare(false), selective = await prepare(true);
  assert.equal(all.requested.length,1028);
  assert.deepEqual(selective.requested,[3,2000,2001,2002]);
  assert.equal(all.provider.prep(1).display_ready,1,'generic provider retains non-houseprice prep');
  const before = structuredClone(rows);
  const run = provider=>buildListListingsRowsAsync(rows,{filter:'all',kind:'',sources:[],sort:'newest',
    uid:101,voteUid:202,settings:{},districtSet:new Set(),flagMap:new Map(),provider,requireProvider:true});
  const fullRows = await run(all.provider), selectedRows = await run(selective.provider);
  assert.deepEqual(selectedRows,fullRows);
  assert.equal(selectedRows.length,1022,'three affiliates are removed by existing relation rules');
  assert.ok(selectedRows.some(r=>r.post_id===3),'ready houseprice candidate retains its primary role');
  assert.ok(!selectedRows.some(r=>[1,4,5].includes(r.post_id)),'system and personal affiliates remain hidden');
  assert.ok(selectedRows.some(r=>r.post_id===2),'unready external peer cannot hide the visible 591 row');
  assert.ok(selectedRows.some(r=>r.post_id===1025),'no candidate truncation');
  assert.deepEqual(rows,before,'shared input stays unchanged');
});
