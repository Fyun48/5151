import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const dir=mkdtempSync(path.join(os.tmpdir(),'crawl-schedule-'));
process.env.DATA_DIR=dir;
const {sqliteHandle}=await import('../src/db.js');
const {reserveCoveringPlan,completeCoveringPlan,crawlRuntimeAsync}=await import('../src/crawlScheduleAsync.js');
const {coverFingerprint}=await import('../src/crawlCovers.js');
const {withPgFixture,withoutSqliteIO}=await import('./fixtures/prb-search.mjs');
const db=sqliteHandle();
after(()=>rmSync(dir,{recursive:true,force:true}));
const at='2026-09-26T00:00:00.000Z';
const later='2026-09-26T02:00:00.000Z';
function seed() {
 db.exec('DELETE FROM user_settings; DELETE FROM users; DELETE FROM settings; DELETE FROM crawl_covers;');
 db.prepare('INSERT INTO users(id,email,role,created_at) VALUES (?,?,?,?)').run(101,'schedule@example.test','admin',at);
 db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('crawlSources',JSON.stringify([{id:'591',enabled:false},{id:'hbhousing',enabled:true},{id:'sinyi',enabled:true}]));
 const urls=Array.from({length:19},(_,i)=>`https://rent.591.com.tw/list?region=${i+1}`);
 for(const [k,v] of Object.entries({searchUrls:urls,memberFetchDueAt:at,notificationsPaused:false}))
  db.prepare('INSERT INTO user_settings(user_id,key,value) VALUES (?,?,?)').run(101,k,JSON.stringify(v));
}
async function exercise(options,read) {
 const runtime=await crawlRuntimeAsync(options);
 assert.equal(runtime.sourceEnabled('591'),false);
 assert.equal(runtime.sourceEnabled('hbhousing'),true);
 assert.equal(runtime.sourceEnabled('sinyi'),true);
 const seen=new Set();
 for(let n=0;n<4;n++) {
  const plan=await reserveCoveringPlan({now:Date.parse(later)+n*1800000,includeSystem:false},options);
  assert.equal(plan.jobs.length,6);
  for(const j of plan.jobs) seen.add(coverFingerprint(j));
  const done=await completeCoveringPlan({successfulJobs:plan.jobs,memberRequirements:plan.memberRequirements,at:later},options);
  if(n<3) assert.deepEqual(done.completedUserIds,[], 'partial member coverage cannot postpone remaining regions');
  else assert.deepEqual(done.completedUserIds,[101]);
 }
 assert.equal(seen.size,19,'irregular 30 minute intervals cover all 19 jobs');
 assert.notEqual(await read(),JSON.stringify(at));
}
test('SQLite persistent fairness, cumulative completion, partial failure and unchanged member settings',async()=>{
 seed();
 const read=()=>db.prepare("SELECT value FROM user_settings WHERE user_id=101 AND key='memberFetchDueAt'").get().value;
 const first=await reserveCoveringPlan({now:Date.parse(later),includeSystem:false},{driver:'sqlite'});
 await completeCoveringPlan({successfulJobs:[],memberRequirements:first.memberRequirements,at:later},{driver:'sqlite'});
 assert.equal(read(),JSON.stringify(at));
 assert.equal(db.prepare('SELECT COUNT(*) n FROM crawl_covers').get().n,0);
 // A fresh invocation reads the durable cursor rather than a clock window.
 const reopened=new DatabaseSync(path.join(dir,'v3.db'));
 let second;
 try { second=await reserveCoveringPlan({now:Date.parse(later),includeSystem:false},{driver:'sqlite',db:reopened}); }
 finally { reopened.close(); }
 assert.equal(second.jobs.some(j=>first.jobs.some(k=>coverFingerprint(j)===coverFingerprint(k))),false);
 seed();await exercise({driver:'sqlite'},read);
 seed();const changed=await reserveCoveringPlan({now:Date.parse(later),includeSystem:false},{driver:'sqlite'});
 db.prepare("UPDATE user_settings SET value=? WHERE key='memberFetchDueAt'").run(JSON.stringify(later));
 await completeCoveringPlan({successfulJobs:changed.jobs,memberRequirements:changed.memberRequirements,at:later},{driver:'sqlite'});
 assert.equal(read(),JSON.stringify(later));
});
test('real PG persistent schedule, atomic reservations and cumulative member completion without SQLite I/O',{skip:!process.env.PG_TEST_URL},async()=>{
 seed();
 await withPgFixture(db,async driver=>withoutSqliteIO(db,async()=>{
  const opts={driver:'postgres',pgDriver:driver};
  const args={now:Date.parse(later),includeSystem:false};
  const [a,b]=await Promise.all([reserveCoveringPlan(args,opts),reserveCoveringPlan(args,opts)]);
  assert.equal(a.jobs.some(j=>b.jobs.some(k=>coverFingerprint(j)===coverFingerprint(k))),false);
  await driver.query("DELETE FROM settings WHERE key='crawlScheduleV1'");
  await exercise(opts,async()=>(await driver.query("SELECT value FROM user_settings WHERE user_id=101 AND key='memberFetchDueAt'")).rows[0].value);
 }));
});
