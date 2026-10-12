import { livePgTargetSkip } from "./helpers/livePgTarget.js";
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {withPgCrawlOwner,currentCrawlOwner,CRAWL_LOCK_KEYS} from '../src/crawlOwnership.js';
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
    if(sql.includes('pg_advisory_unlock')) {locked=false;return {rows:[{released:true}]};}
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
// ⚠️ 安全：PG_TEST_URL 在本機指向正式庫 5151_shadow，目標庫不在允許清單就整支 skip。
//    守衛必須在建立連線之前（見 v3/test/helpers/livePgTarget.js）。
const GUARD_SKIP = await livePgTargetSkip("crawl-ownership");
const LIVE_SKIP = GUARD_SKIP || (!process.env.PG_TEST_URL ? "PG_TEST_URL is not set (real PG crawler ownership)" : false);

test('real PG ownership excludes a second pool and releases on success and failure',{ skip: LIVE_SKIP },async()=>{
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

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-12：owner advisory lock 洩漏（「資料不再前進」的根因之一）的回歸測試。
//
// 正式站實查：`pg_locks` 有一筆 `locktype=advisory, classid=5151, objid=20260926,
// mode=ExclusiveLock, granted=true`，持有者是一條 `application_name=5151-v3`、
// `state=idle in transaction`、最後一句 `SAVEPOINT revision_bump` 的 session；另一節點
// 每 60 秒只回 `owner_busy`。session 級 advisory lock 只在 session 結束時才保證釋放。
//
// 斷言分兩層：
//   • 交辦指定的兩條：T1「work 內 throw 之後 (5151,20260926) 在 pg_locks 為 0」、
//     T2「取與解必須同一條連線」；
//   • 這次事故真正的形狀，也是修補前會紅的兩條：T3「in-flight 交易永遠不結束時仍必須
//     有界釋放」、T4「解鎖未被確認時不得把連線放回池」。
// ⚠️ 安全性照抄本檔既有的 live PG 慣例：守衛在建立連線之前，目標庫不在允許清單就整支 skip。
// ─────────────────────────────────────────────────────────────────────────────
const LOCK_KEY_PREDICATE = "locktype='advisory' AND classid=5151 AND objid=20260926";
// 這把 key 在共用 lab 庫（repro）可能有別的 session 的殘鎖，所以 T1 用「持有者不得增加」
// 證明不是我們留的；在乾淨的庫（CI 的拋棄式 tracker_test）會直接走到字面上的 0。
const lockPids = async driver => (await driver.query(
  `SELECT pid FROM pg_locks WHERE ${LOCK_KEY_PREDICATE} ORDER BY pid`)).rows.map(r=>Number(r.pid));
const lockCountFor = async (driver,pid) => Number((await driver.query(
  `SELECT COUNT(*)::int AS n FROM pg_locks WHERE ${LOCK_KEY_PREDICATE} AND pid=$1`,[pid])).rows[0].n);
async function waitForLockCount(driver,pid,want,timeoutMs) {
 let last=-1;
 for (const deadline=Date.now()+timeoutMs;Date.now()<=deadline;) {
  last=await lockCountFor(driver,pid);
  if(last===want) return last;
  await new Promise(r=>setTimeout(r,100));
 }
 return last;
}

test('real PG：work 內 throw（含交易內 throw）之後，(5151,20260926) 在 pg_locks 必須為 0',{ skip: LIVE_SKIP },async()=>{
 const driver=await createPostgresDriver({connectionString:process.env.PG_TEST_URL,poolOptions:{max:2}});
 try {
  const before=await lockPids(driver);
  await assert.rejects(withPgCrawlOwner(driver,async()=>{throw new Error('work failed');}),/work failed/);
  const afterThrow=await lockPids(driver);
  assert.deepEqual(afterThrow,before,`work 直接 throw 之後持有者不得增加：before=[${before}] after=[${afterThrow}]`);
  await assert.rejects(withPgCrawlOwner(driver,async()=>{
   await currentCrawlOwner().transact(async()=>{throw new Error('transaction failed');});
  }),/transaction failed/);
  const after=await lockPids(driver);
  assert.deepEqual(after,before,`交易內 throw 之後持有者不得增加：before=[${before}] after=[${after}]`);
  if(before.length===0) assert.equal(after.length,0,'(5151,20260926) 在 pg_locks 內必須為 0');
 } finally { await driver.close(); }
});

test('real PG：取鎖與解鎖必須在同一條連線（別的連線解不掉，鎖會留在原 session）',{ skip: LIVE_SKIP },async()=>{
 const a=await createPostgresDriver({connectionString:process.env.PG_TEST_URL,poolOptions:{max:2}});
 const b=await createPostgresDriver({connectionString:process.env.PG_TEST_URL,poolOptions:{max:2}});
 const entered=deferred(),finish=deferred();
 let ownerPid=null,ownerClient=null;
 try {
  const first=withPgCrawlOwner(a,async()=>{
   // `owner.client`（currentCrawlOwner()）就是持鎖的那條連線：整段 crawl 都用它。
   ownerClient=currentCrawlOwner().client;
   ownerPid=Number((await ownerClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
   entered.resolve();await finish.promise;return 'ok';
  });
  await entered.promise;
  assert.equal(await lockCountFor(a,ownerPid),1,'持有鎖的必須就是 owner 借出的那條連線');
  // 負向對照：`pg_advisory_unlock` 落在別條連線時回 false，鎖仍留在原 session。
  const denied=(await b.query('SELECT pg_advisory_unlock($1,$2) AS released',CRAWL_LOCK_KEYS)).rows[0].released;
  assert.equal(denied,false,'不同連線的 pg_advisory_unlock 必須回 false');
  assert.equal(await lockCountFor(a,ownerPid),1,'別條連線解鎖失敗後，鎖必須仍在原 session');
  finish.resolve();
  assert.equal(await first,'ok');
  assert.equal(await lockCountFor(a,ownerPid),0,'owner 用自己的連線解鎖後必須歸零');
  // 第三條連線再也解不到東西 ⇒ 釋放確實發生在 owner 的 session 上（不是被別條連線解掉）。
  const again=(await b.query('SELECT pg_advisory_unlock($1,$2) AS released',CRAWL_LOCK_KEYS)).rows[0].released;
  assert.equal(again,false,'owner 已釋放 ⇒ 其他連線不得再解到任何鎖');
 } finally {
  finish.resolve();
  try { ownerClient?.release?.(true); } catch { /* 已被 withPgCrawlOwner 釋放或銷毀 */ }
  await a.close();await b.close();
 }
});

test('real PG：in-flight 交易永遠不結束時，abort 之後鎖仍必須在有界時間內歸零',{ skip: LIVE_SKIP },async()=>{
 const driver=await createPostgresDriver({connectionString:process.env.PG_TEST_URL,poolOptions:{max:2}});
 const watcher=await createPostgresDriver({connectionString:process.env.PG_TEST_URL,poolOptions:{max:1}});
 const entered=deferred();
 let ownerClient=null,ownerPid=null;
 const controller=new AbortController();
 const run=withPgCrawlOwner(driver,async()=>{
  ownerClient=currentCrawlOwner().client;
  // 正式站的形狀：`driver.withTransaction()` 在 owner 底下會借用 owner 的那條連線
  // （`writeThenBump` 就是這樣），所以這是一個真的開著的交易。
  await driver.withTransaction(async(client)=>{
   await client.query('SAVEPOINT crawl_owner_stuck');
   ownerPid=Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
   entered.resolve();
   await new Promise(()=>{});
  });
 },{signal:controller.signal,unlockWaitMs:1000});
 run.catch(()=>{});
 try {
  await entered.promise;
  assert.equal(await lockCountFor(watcher,ownerPid),1,'所有權連線必須持有鎖');
  controller.abort(new Error('budget exhausted'));
  const left=await waitForLockCount(watcher,ownerPid,0,8000);
  assert.equal(left,0,'abort 之後鎖必須歸零：不得因為 in-flight 交易沒收尾就無限期留著');
 } finally {
  run.catch(()=>{});
  try { ownerClient?.release?.(true); } catch { /* 已被 withPgCrawlOwner 釋放或銷毀 */ }
  await driver.close();await watcher.close();
 }
});

test('unit：解鎖未被確認（pg_advisory_unlock 回 false）時，不得把連線放回池',async()=>{
 const calls=[];let locked=false,releasedToPool=null;
 class Pool extends EventEmitter {
  async connect() {
   const c=new EventEmitter();
   c.query=async(sql)=>{
    calls.push(sql);
    if(sql.includes('pg_try_advisory_lock')) {const acquired=!locked;if(acquired)locked=true;return {rows:[{acquired}]};}
    if(sql.includes('pg_advisory_unlock')) return {rows:[{released:false}]};
    return {rows:[]};
   };
   c.release=destroy=>{releasedToPool=destroy?'destroy':'pool';if(destroy)locked=false;};
   return c;
  }
  async query(){throw new Error('crawler write escaped to pool.query');}
  async end(){}
 }
 const driver=await createPostgresDriver({env:{},importPg:async()=>({Pool})});
 assert.equal(await withPgCrawlOwner(driver,async()=>42),42);
 assert.equal(calls.some(x=>x.includes('pg_advisory_unlock')),true,'離開時必須嘗試解鎖');
 assert.equal(releasedToPool,'destroy','解鎖未被確認 ⇒ 必須銷毀該 session，否則 session 級鎖會留在池裡的連線上');
 await driver.close();
});
