import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresDriver } from '../src/dbDriverPostgres.js';
import { createCandidateContentStore } from '../src/pgCandidateContent.js';
import { LIST_CANDIDATE_KEYS, LIST_CANDIDATE_COLUMNS } from '../src/listingCandidateRow.js';
import { withPgReadSnapshot, readPgRows } from '../src/pgReadSnapshot.js';

test('candidate content store bounds rows/bytes and refuses mutable PG values', () => {
  const store = createCandidateContentStore({ maxRows: 2, maxBytes: 3000 });
  const identity = store.bindIdentity('one');
  for (let i = 1; i <= 10; i++) store.put(i, 'v1', identity, { post_id:i, title:'title' });
  assert.equal(store.get(1, 'v1', identity), null);
  assert.ok(store.get(10, 'v1', identity));
  assert.equal(store.get(10, 'v2', identity), null);
  assert.equal(store.get(10, 'v1', 'other-schema'), null);
  store.put(11, 'v1', identity, { post_id:11, title:'x'.repeat(3000) });
  store.put(12, 'v1', identity, { post_id:12, tags:[] });
  assert.equal(store.get(11, 'v1', identity), null);
  assert.equal(store.get(12, 'v1', identity), null);
  assert.ok(store.inspect().rows <= 2);
  assert.ok(store.inspect().bytes <= 3000);
  store.bindIdentity('two');
  assert.equal(store.inspect().rows, 0);
});

const connectionString = process.env.PG_TEST_URL || '';
test('live PG: reused content belongs to the visible row version and full column contract',
  { skip: !connectionString && 'PG_TEST_URL is not set' }, async t => {
    const schema = `content_${randomUUID().replaceAll('-', '')}`;
    const other = `${schema}_other`;
    const role = `${schema}_reader`;
    const admin = await createPostgresDriver({ connectionString });
    let driver;
    let roleCreated = false;
    const definition = LIST_CANDIDATE_KEYS.map(key => `${key} ${key === 'post_id' ? 'bigint PRIMARY KEY' : 'text'}`).join(', ');
    const sql = `SELECT ${LIST_CANDIDATE_COLUMNS} FROM listings WHERE post_id > $1 ORDER BY post_id`;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`CREATE SCHEMA ${other}`);
      await admin.query(`CREATE TABLE ${schema}.listings (${definition})`);
      await admin.query(`CREATE TABLE ${other}.listings (${definition})`);
      driver = await createPostgresDriver({ connectionString, poolOptions: { max:4, options:`-c search_path=${schema}` } });
      const seen = [];
      const observed = { candidateContent:driver.candidateContent, pool:{connect:async()=>{
        const client = await driver.pool.connect();
        return { release:(...args)=>client.release(...args), query:(query,params)=>{
          seen.push(typeof query === 'string' ? query : query.text);
          return client.query(query,params);
        } };
      } } };
      const read = (minimum=0) => withPgReadSnapshot(observed, snapshot => readPgRows(snapshot, sql, [minimum], {arrayRows:true}));
      const seed = async () => {
        await driver.query('TRUNCATE listings');
        await driver.query("INSERT INTO listings(post_id,title,source,refresh_time) VALUES(1,'one','591','2026-09-25'),(2,'two','self','2026-09-26')");
        driver.candidateContent.clear();
        seen.length=0;
      };

      await t.test('warm reads select fresh versions, preserve ordering/scope and return isolated objects', async () => {
        await seed();
        const cold=await read();
        const expected=(await driver.query(sql,[0])).rows;
        assert.deepEqual(cold,expected);
        cold[0].title='caller mutation';
        seen.length=0;
        assert.deepEqual(await read(),expected);
        assert.ok(seen.some(q=>q.includes('xmin::text')));
        assert.ok(!seen.some(q=>q.startsWith('DECLARE') && q.includes('WHERE post_id = ANY')));
        assert.deepEqual((await read(1)).map(r=>r.post_id),[2]);
        const byTime = asOf => withPgReadSnapshot(observed, snapshot => readPgRows(snapshot,
          `SELECT ${LIST_CANDIDATE_COLUMNS} FROM listings WHERE refresh_time <= $1 ORDER BY post_id`,[asOf],{arrayRows:true}));
        assert.deepEqual((await byTime('2026-09-25')).map(r=>r.post_id),[1]);
        assert.deepEqual((await byTime('2026-09-26')).map(r=>r.post_id),[1,2]);
      });
      await t.test('committed updates, inserts and deletes are visible; rollback stays invisible', async () => {
        await seed(); await read();
        await driver.query("UPDATE listings SET title='changed' WHERE post_id=1");
        await driver.query('DELETE FROM listings WHERE post_id=2');
        await driver.query("INSERT INTO listings(post_id,title) VALUES(3,'three')");
        assert.deepEqual(await read(),(await driver.query(sql,[0])).rows);
        const writer=await driver.pool.connect();
        try {
          await writer.query('BEGIN');
          await writer.query("UPDATE listings SET title='rollback' WHERE post_id=1");
          assert.equal((await read())[0].title,'changed');
          await writer.query('ROLLBACK');
        } finally { writer.release(); }
        assert.equal((await read())[0].title,'changed');
      });
      await t.test('streamed versions preserve all fields, order and cold/warm rows across reply boundaries', async () => {
        await seed();
        await driver.query('TRUNCATE listings');
        await driver.query("INSERT INTO listings(post_id,title,source,price_num) SELECT i, '住宅 ' || i, '591', i::text FROM generate_series(1,8705) i");
        const expected=(await driver.query(sql,[0])).rows;
        const cold=await read();
        assert.deepEqual(cold,expected);
        cold[512].title='private mutation';
        const warm=await read();
        assert.deepEqual(warm,expected);
        assert.deepEqual(await read(8000),expected.filter(row=>row.post_id>8000));
        assert.equal(warm.length,8705);
        assert.equal(warm.at(-1).post_id,8705);
      });
      await t.test('old and new repeatable-read snapshots cannot replace each other’s row content', async () => {
        await seed();
        await withPgReadSnapshot(observed,async old=>{
          const oldRows=await readPgRows(old,sql,[0],{arrayRows:true});
          await driver.query("UPDATE listings SET title='new snapshot' WHERE post_id=1");
          assert.equal((await read())[0].title,'new snapshot');
          assert.deepEqual(await readPgRows(old,sql,[0],{arrayRows:true}),oldRows);
        });
        assert.equal((await read())[0].title,'new snapshot');
      });
      await t.test('search_path, truncate and column replacement invalidate content', async () => {
        await seed(); await read();
        await driver.query(`INSERT INTO ${other}.listings(post_id,title) VALUES(1,'other schema')`);
        await withPgReadSnapshot(observed,async snapshot=>{
          await snapshot.query(`SET LOCAL search_path=${other}`);
          assert.equal((await readPgRows(snapshot,sql,[0],{arrayRows:true}))[0].title,'other schema');
        });
        assert.equal((await read())[0].title,'one');
        await driver.query('TRUNCATE listings');
        await driver.query("INSERT INTO listings(post_id,title) VALUES(1,'after truncate')");
        assert.equal((await read())[0].title,'after truncate');
        await driver.query('ALTER TABLE listings DROP COLUMN title');
        await driver.query("ALTER TABLE listings ADD COLUMN title text DEFAULT 'replacement'");
        assert.equal((await read())[0].title,'replacement');
      });
      await t.test('a dropped required column fails even when all raw content was warm', async () => {
        await read();
        await driver.query('ALTER TABLE listings DROP COLUMN tags');
        await assert.rejects(read(),error=>error.code==='42703');
        await driver.query('ALTER TABLE listings ADD COLUMN tags text');
      });
      await t.test('RLS tables keep their original read path', async () => {
        await seed();
        await driver.query('ALTER TABLE listings ENABLE ROW LEVEL SECURITY');
        seen.length=0;
        assert.deepEqual(await read(),(await driver.query(sql,[0])).rows);
        assert.ok(!seen.some(q=>q.includes('xmin::text')));
        await driver.query('ALTER TABLE listings DISABLE ROW LEVEL SECURITY');
      });
      await t.test('revoked SELECT fails on warm content; column-only grants retain the ordinary path', async () => {
        await seed();
        await admin.query(`CREATE ROLE ${role} NOLOGIN`);
        roleCreated = true;
        await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
        await admin.query(`GRANT SELECT ON ${schema}.listings TO ${role}`);
        const asRole = () => withPgReadSnapshot(observed, async snapshot => {
          await snapshot.query(`SET LOCAL ROLE ${role}`);
          return readPgRows(snapshot, sql, [0], {arrayRows:true});
        });
        const expected = await read();
        assert.deepEqual(await asRole(), expected);
        assert.deepEqual(await asRole(), expected);
        await admin.query(`REVOKE SELECT ON ${schema}.listings FROM ${role}`);
        await assert.rejects(asRole(), error => error.code === '42501');
        await admin.query(`GRANT SELECT (${LIST_CANDIDATE_COLUMNS}) ON ${schema}.listings TO ${role}`);
        seen.length = 0;
        assert.deepEqual(await asRole(), expected);
        assert.ok(!seen.some(query => query.includes('xmin::text')));
      });
      await t.test('eviction and oversize rows affect performance only, never selection or complete content', async () => {
        await seed();
        await driver.query("UPDATE listings SET title=repeat('large',1000) WHERE post_id=1");
        const bounded = {...observed,candidateContent:createCandidateContentStore({maxRows:1,maxBytes:2000})};
        const expected=(await driver.query(sql,[0])).rows;
        for(let i=0;i<3;i++) {
          assert.deepEqual(await withPgReadSnapshot(bounded,snapshot=>readPgRows(snapshot,sql,[0],{arrayRows:true})),expected);
        }
        assert.ok(bounded.candidateContent.inspect().rows<=1);
        assert.ok(bounded.candidateContent.inspect().bytes<=2000);
      });
    } finally {
      await driver?.close();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS ${other} CASCADE`);
      if (roleCreated) await admin.query(`DROP ROLE ${role}`);
      await admin.close();
    }
  });
