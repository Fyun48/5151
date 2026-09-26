import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {withPgCrawlOwner} from '../src/crawlOwnership.js';
import {withBudget} from '../src/crawlWatchdog.js';
import {guardCrawlSqlite,crawlRequestSignal} from '../src/crawlExecution.js';
import {createPostgresDriver} from '../src/dbDriverPostgres.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
function fixture() {
 let locked=false;
 const calls=[],clients=[];
 const active=deferred(),finish=deferred();
 class Pool extends EventEmitter {
  async connect() {
   const c=new EventEmitter();
   clients.push(c);
   c.query=async(sql)=>{
    calls.push(sql);
    if(sql.includes('pg_try_advisory_lock')) {const acquired=!locked;if(acquired)locked=true;return {rows:[{acquired}]};}
    if(sql.includes('pg_advisory_unlock')) locked=false;
    if(sql==='SLOW WRITE') {active.resolve();await finish.promise;}
    return {rows:[]};
   };
   c.release=destroy=>{if(destroy)locked=false;calls.push('release');};
   return c;
  }
  async query(){throw new Error('crawler write escaped to pool.query');}
  async end(){}
 }
 return {calls,clients,active,finish,importPg:async()=>({Pool})};
}
test('a second worker cannot run, owner queries serialize on the locked connection, late work is rejected',async()=>{
 const f=fixture(),driver=await createPostgresDriver({env:{},importPg:f.importPg});
 const started=deferred(),finish=deferred();
 const first=withBudget(()=>withPgCrawlOwner(driver,async()=>{
  started.resolve();
  await Promise.all([driver.query('WRITE A'),driver.query('WRITE B')]);
  await finish.promise;
  return 'done';
 }),5000);
 await started.promise;
 const second=await withPgCrawlOwner(driver,()=>assert.fail('second owner ran'));
 assert.equal(second.skipped,'owner_busy');
 finish.resolve();assert.equal(await first,'done');
 assert.deepEqual(f.calls.filter(x=>['BEGIN','WRITE A','WRITE B','COMMIT'].includes(x)),['BEGIN','WRITE A','COMMIT','BEGIN','WRITE B','COMMIT']);
 const next=await withPgCrawlOwner(driver,async()=>{await driver.query('WRITE C');return 'next';});
 assert.equal(next,'next');
 await driver.close();
});
test('abort fences in-flight SQL before COMMIT and waits for rollback before unlocking',async()=>{
 const f=fixture(),driver=await createPostgresDriver({env:{},importPg:f.importPg});
 const controller=new AbortController();
 const released=deferred();let lateResult;
 const run=withBudget(signal=>withPgCrawlOwner(driver,async()=>{
  lateResult=released.promise.then(()=>driver.query('LATE'));
  // Attach a handler before triggering abort to avoid an unhandled rejection.
  lateResult.catch(()=>{});
  await driver.query('SLOW WRITE');
 },{signal}),5000,'test',{signal:controller.signal});
 await f.active.promise;
 controller.abort(new Error('cancel owner'));
 await assert.rejects(run,/cancel owner/);
 assert.equal(f.calls.some(x=>x.includes('pg_advisory_unlock')),false);
 f.finish.resolve();released.resolve();
 await assert.rejects(lateResult,/cancel owner|ownership has ended/);
 // Owner cleanup continues after the public watchdog has returned timeout.
 for(let n=0;n<20&&!f.calls.some(x=>x.includes('pg_advisory_unlock'));n++) await new Promise(r=>setImmediate(r));
 assert.ok(f.calls.includes('ROLLBACK'));
 assert.equal(f.calls.includes('COMMIT'),false);
 assert.equal(f.calls.includes('LATE'),false);
 assert.ok(f.calls.indexOf('ROLLBACK')<f.calls.findIndex(x=>x.includes('pg_advisory_unlock')));
 await driver.close();
});
test('connection loss aborts network signals and fences late SQLite callbacks',async()=>{
 const f=fixture(),driver=await createPostgresDriver({env:{},importPg:f.importPg});
 const entered=deferred(),later=deferred(),hold=deferred();let late,network;
 const writes=[];
 const sqlite=guardCrawlSqlite({exec:sql=>writes.push(sql)});
 const run=withBudget(signal=>withPgCrawlOwner(driver,async()=>{
  network=crawlRequestSignal(new AbortController().signal);
  late=later.promise.then(()=>sqlite.exec('LATE SQLITE'));
  late.catch(()=>{});
  entered.resolve();await hold.promise;
 },{signal}),5000);
 await entered.promise;
 f.clients[0].emit('error',new Error('connection lost'));
 await assert.rejects(run,/connection lost/);
 assert.equal(network.aborted,true);
 later.resolve();await assert.rejects(late,/connection lost|ownership has ended/);
 assert.deepEqual(writes,[]);
 hold.resolve();
 assert.equal(await withPgCrawlOwner(driver,async()=>42),42);
 await driver.close();
});
test('nested driver transactions reject explicitly instead of deadlocking the ownership queue',async()=>{
 const f=fixture(),driver=await createPostgresDriver({env:{},importPg:f.importPg});
 await assert.rejects(withPgCrawlOwner(driver,()=>driver.withTransaction(()=>driver.query('NESTED'))),/Nested crawler transaction/);
 assert.ok(f.calls.includes('ROLLBACK'));
 assert.equal(f.calls.includes('COMMIT'),false);
 assert.equal(await withPgCrawlOwner(driver,async()=>42),42);
 await driver.close();
});
test('real PG ownership excludes a second pool and releases on success and failure',{skip:!process.env.PG_TEST_URL},async()=>{
 const a=await createPostgresDriver({connectionString:process.env.PG_TEST_URL,poolOptions:{max:2}});
 const b=await createPostgresDriver({connectionString:process.env.PG_TEST_URL,poolOptions:{max:2}});
 const entered=deferred(),finish=deferred();
 try {
  const first=withBudget(signal=>withPgCrawlOwner(a,async()=>{
   await a.query('CREATE TEMP TABLE crawl_owner_test (n INTEGER)');
   await Promise.all([a.query('INSERT INTO crawl_owner_test VALUES(1)'),a.query('INSERT INTO crawl_owner_test VALUES(2)')]);
   assert.equal((await a.query('SELECT COUNT(*)::int n FROM crawl_owner_test')).rows[0].n,2);
   entered.resolve();await finish.promise;
  },{signal}),5000);
  await entered.promise;
  assert.equal((await withPgCrawlOwner(b,()=>assert.fail('overlap'))).skipped,'owner_busy');
  finish.resolve();await first;
  await assert.rejects(withPgCrawlOwner(b,()=>{throw new Error('work failed');}),/work failed/);
  assert.equal(await withPgCrawlOwner(a,async()=>42),42);
 } finally { finish.resolve();await a.close();await b.close(); }
});
