import { resolveDbDriver } from './dbDriver.js';
import { sharedPgDriver } from './pgSharedDriver.js';
import { sqliteHandle, settingsFromRows, systemCrawlFromRows } from './db.js';
import { toPostgresSql } from './sqlDialect.js';
import { coverFingerprint } from './crawlCovers.js';
import { coversFromMemberSettings, coversFromWatchDistricts, coveringJobsFromMembers, coverContains } from './covering.js';
import { parseSettingRows, planIntervalMinutes } from './settingsState.js';
import { COVERING_JOBS_PER_RUN } from './crawlPolicy.js';

import { crawlSourceEnabled } from './crawlSources.js';

export async function crawlRuntimeAsync(options={}) {
  return scheduleTransaction(options,async exec=>{
    const rows=await exec('SELECT key,value FROM settings');
    const system=systemCrawlFromRows(rows);
    const stored=parseSettingRows(rows);
    return {settings:settingsFromRows({globalRows:rows,system}),system,
      sourceEnabled:id=>crawlSourceEnabled(stored.crawlSources,id)};
  });
}

const KEY = 'crawlScheduleV1';
const UPSERT = 'INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value';
export async function scheduleTransaction(options, fn) {
  if ((options.driver || resolveDbDriver()) === 'postgres') {
    const driver = options.pgDriver || await sharedPgDriver();
    return driver.withTransaction(async client => fn(async (sql, params=[]) =>
      (await client.query(toPostgresSql(sql),params)).rows, true));
  }
  const db = options.db || sqliteHandle();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = await fn(async (sql,params=[]) => {
      const stmt=db.prepare(sql);
      return /^\s*SELECT/i.test(sql) ? stmt.all(...params) : (stmt.run(...params), []);
    },false);
    db.exec('COMMIT');
    return result;
  } catch(e) { db.exec('ROLLBACK'); throw e; }
}
async function stateForUpdate(exec,pg) {
  await exec('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING',[KEY,'{}']);
  const rows=await exec('SELECT value FROM settings WHERE key=?'+(pg?' FOR UPDATE':''),[KEY]);
  const state=JSON.parse(rows[0].value);
  return {counter:0,attempts:{},completed:{},...state};
}
async function readPlan(exec,{now=Date.now(),includeSystem=true}={}) {
  const globalRows=await exec('SELECT key,value FROM settings');
  const users=await exec("SELECT * FROM users WHERE deleted_at IS NULL OR deleted_at='' ORDER BY id");
  const allSettings=await exec('SELECT user_id,key,value FROM user_settings');
  const system=systemCrawlFromRows(globalRows);
  const memberRequirements=[];
  const covers=includeSystem ? coversFromWatchDistricts({watchDistricts:system.watchDistricts}) : [];
  for(const user of users) {
    const settings=settingsFromRows({globalRows,userRows:allSettings.filter(r=>Number(r.user_id)===Number(user.id)),user,system});
    const due=Date.parse(settings.memberFetchDueAt || '');
    if(settings.notificationsPaused || !Number.isFinite(due) || due>now) continue;
    const required=coversFromMemberSettings(settings);
    if(!required.length) continue;
    covers.push(...required);
    memberRequirements.push({id:user.id,dueAt:settings.memberFetchDueAt,covers:required});
  }
  return {jobs:coveringJobsFromMembers(covers,{excludeRooftop:false}),memberRequirements,includeSystem};
}
export async function coveringPlanAsync(input={},options={}) {
  return scheduleTransaction(options,exec=>readPlan(exec,input));
}
// Reservation commits before network work. Failed attempts remain due but rotate
// behind other scopes; restart and irregular tick intervals cannot skip a window.
export async function reserveCoveringPlan(input={},options={}) {
  return scheduleTransaction(options,async(exec,pg)=>{
    const state=await stateForUpdate(exec,pg);
    const plan=await readPlan(exec,input);
    const ranked=plan.jobs.map((job,index)=>({job,index,key:coverFingerprint(job)}))
      .sort((a,b)=>(state.attempts[a.key]||0)-(state.attempts[b.key]||0)||a.index-b.index);
    const jobs=ranked.slice(0,COVERING_JOBS_PER_RUN).map(({job,key})=>{
      state.attempts[key]=++state.counter;
      return job;
    });
    await exec(UPSERT,[KEY,JSON.stringify(state)]);
    return {...plan,jobs};
  });
}
export async function completeCoveringPlan({successfulJobs=[],memberRequirements=[],at=new Date().toISOString()}={},options={}) {
  if(!successfulJobs.length) return {completedUserIds:[],coversTouched:false};
  return scheduleTransaction(options,async(exec,pg)=>{
    const state=await stateForUpdate(exec,pg);
    const existing=await exec('SELECT id,region_id,section_ids,price_min,price_max FROM crawl_covers');
    for(const job of successfulJobs) {
      const key=coverFingerprint(job);
      state.completed[key]={cover:job,at};
      const ids=existing.filter(r=>coverFingerprint({regionId:r.region_id,sectionIds:JSON.parse(r.section_ids||'[]'),priceMin:r.price_min,priceMax:r.price_max})===key).map(r=>r.id);
      if(ids.length) for(const id of ids) await exec('UPDATE crawl_covers SET last_run_at=? WHERE id=?',[at,id]);
      else await exec('INSERT INTO crawl_covers(region_id,section_ids,price_min,price_max,last_run_at,created_at) VALUES (?,?,?,?,?,?)',
        [job.regionId,JSON.stringify([...new Set(job.sectionIds||[])].sort((a,b)=>a-b)),job.priceMin||0,job.priceMax||0,at,at]);
    }
    const current=await readPlan(exec,{now:Date.parse(at),includeSystem:false});
    const completedUserIds=[];
    for(const member of memberRequirements) {
      const live=current.memberRequirements.find(r=>Number(r.id)===Number(member.id));
      // Settings changed during the crawl: never postpone a different request.
      if(!live || live.dueAt!==member.dueAt || JSON.stringify(live.covers)!==JSON.stringify(member.covers)) continue;
      const due=Date.parse(member.dueAt);
      if(!member.covers.every(cover=>Object.values(state.completed).some(done=>Date.parse(done.at)>=due && coverContains(done.cover,cover)))) continue;
      const user=(await exec('SELECT plan FROM users WHERE id=?',[member.id]))[0];
      const next=new Date(Date.parse(at)+planIntervalMinutes(user?.plan)*60000).toISOString();
      await exec('UPDATE user_settings SET value=? WHERE user_id=? AND key=? AND value=?',
        [JSON.stringify(next),member.id,'memberFetchDueAt',JSON.stringify(member.dueAt)]);
      completedUserIds.push(member.id);
    }
    await exec(UPSERT,[KEY,JSON.stringify(state)]);
    await exec(UPSERT,['lastCoveringAt',JSON.stringify(at)]);
    return {completedUserIds,coversTouched:true};
  });
}
