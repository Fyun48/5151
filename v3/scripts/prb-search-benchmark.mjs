// Disposable PostgreSQL only. The helper creates a private schema and drops it
// in finally; never point PG_TEST_URL at the production database.
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
const dir=mkdtempSync(path.join(os.tmpdir(),'prb-perf-'));
process.env.DATA_DIR=dir;
process.env.DB_DRIVER='postgres';
const {sqliteHandle}=await import('../src/db.js');
const {loadListingPage}=await import('../src/listingSearchPage.js');
const {withPgReadSnapshot}=await import('../src/pgReadSnapshot.js');
const {withPgFixture,withoutSqliteIO,seedBase,AS_OF,KEY,SETTINGS,DISTRICTS,BASE}=await import('../test/fixtures/prb-search.mjs');
const db=sqliteHandle();
const totalRows=Number(process.env.PERF_ROWS)||120000;
const activeRows=Math.min(Number(process.env.PERF_ACTIVE_ROWS)||36000,totalRows);
if(totalRows<120000||activeRows<36000) throw new Error('Acceptance requires at least 120k stored and 36k active rows');
const target=process.env.PERF_TARGET||'ci';
if(!['ci','nas'].includes(target)) throw new Error('PERF_TARGET must be ci or nas');
const runs=Math.max(50,Number(process.env.PERF_RUNS)||50);
const warms=Math.max(5,Number(process.env.PERF_WARMS)||5);
const out=path.resolve(process.env.PERF_OUTPUT || 'artifacts/prb-search-benchmark.json');
const root=fileURLToPath(new URL('../..',import.meta.url));
const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const hashes=Object.fromEntries(['db.js','listingSearchPage.js','listingSearchNodePg.js','listingStatsAsync.js','pgReadSnapshot.js','listingCandidateRow.js','listDistrictSql.js','cooperative.js','personalFlags.js','repository/listingStats.js','repository/decorationData.js'].map(f=>[f,createHash('sha256').update(readFileSync(new URL(`../src/${f}`,import.meta.url))).digest('hex')]));
const evidence={status:'RUNNING',target,sourceSha:process.env.SOURCE_SHA||sha,checkoutSha:sha,moduleHashes:hashes,
  node:process.version,hardware:{platform:os.platform(),arch:os.arch(),cpus:os.cpus().length,cpu:os.cpus()[0]?.model,memoryBytes:os.totalmem()},
  fixture:{version:'prb-fixed-v1',asOf:AS_OF,totalRows,activeRows,chainLength:Math.min(activeRows,1024),description:'120k stored / 36k in the selected search scope; two districts; deterministic prices, long relation chain and cross-district peers'},
  warms,runs,cases:[]};
const save=()=>{mkdirSync(path.dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(evidence,null,2)+'\n');};
const percentile=(items,p)=>{const a=[...items].sort((a,b)=>a-b);return a[Math.max(0,Math.ceil(a.length*p)-1)]??null;};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
seedBase(db);
try {
  if(!process.env.PG_TEST_URL) throw new Error('PG_TEST_URL must name a disposable test database');
  await withPgFixture(db,async driver=>{
    evidence.postgres=(await driver.query('SHOW server_version')).rows[0].server_version;
    await driver.query('DELETE FROM listings');
    await driver.query(`INSERT INTO listings(post_id,source,source_id,source_key,search_key,title,url,price,price_num,
      address,area_name,floor_name,kind_name,tags,extra_fees,first_seen_at,last_seen_at,refresh_time,offline,offline_confirmed,hidden,
      match_post_id,match_level)
      SELECT $1+i,'591',($1+i)::text,CASE WHEN i%2=0 THEN '1|2' ELSE '1|3' END,
        CASE WHEN i<=$3 THEN $4 ELSE 'https://example.test/another-member-scope' END,
        '住宅 Park '||i,'https://example.test/perf/'||i,
        (10000+i%20000)::text||'元',10000+i%20000,
        '台北市測試路'||i||'號', '20坪','5/12','整層住家/電梯大樓','[]','[]',
        to_char(($5::text)::timestamptz-i*interval '1 minute','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        $5::text,$5::text,0,0,0,CASE WHEN i<LEAST($3,1024) THEN $1+i+1 ELSE 0 END,
        CASE WHEN i<LEAST($3,1024) THEN 'high' ELSE '' END
      FROM generate_series(1,$2::integer) i`,[BASE,totalRows,activeRows,KEY,AS_OF]);
    // ANALYZE is confined to the newly created test schema.
    await driver.query('ANALYZE listings');
    const settings={...SETTINGS,searchUrls:[],watchDistricts:[]};
    for(const scope of ['single','all']) for(const concurrency of [1,4]) {
      const input={filter:'all',sort:'newest',limit:50,offset:0,userId:101,matchVoteUserId:202,
        searchKeys:[KEY],districts:scope==='single'?[DISTRICTS[0]]:[],settings,asOf:AS_OF};
      // Independently derived from the fixed increasing-price 1..1024 chain:
      // only its first (odd-district) primary survives; remaining rows are solo.
      const expected={matched:scope==='single'?Math.floor(activeRows/2)-512:activeRows-1023,
        total:activeRows,dbTotal:totalRows,
        pageIds:scope==='single'?Array.from({length:50},(_,i)=>BASE+1026+2*i):[BASE+1,...Array.from({length:49},(_,i)=>BASE+1025+i)]};
      const samples=[],queries=[],transactions=[],errors=[];
      let baseline=null,rss=0,heap=0;
      const stageSamples={},coldQueries=[],planInputs=[],coldPlans=[];
      let captureCold=true;
      async function request(measure=false) {
        let count=0,tx=0;
        const counted={query:()=>{throw new Error('outside snapshot');},pool:{connect:async()=>{
          const client=await driver.pool.connect();
          return {release:(...a)=>client.release(...a),query:async(sql,params)=>{
            const text=typeof sql==='string'?sql:sql.text;
            if(/^\s*(BEGIN|COMMIT|ROLLBACK|SET)\b/i.test(text)) tx++; else count++;
            const queryStart=performance.now();
            const result=await client.query(sql,params);
            if(captureCold) {
              const normalized=text.replace(/\s+/g,' ').slice(0,150);
              const prior=coldQueries.at(-1);
              if(prior?.sql===normalized) {prior.calls++;prior.ms+=performance.now()-queryStart;prior.rows+=result.rowCount||0;}
              else coldQueries.push({sql:normalized,calls:1,ms:performance.now()-queryStart,rows:result.rowCount});
              if(/^DECLARE /.test(text) && /SELECT post_id(?:, source,| FROM listings)/.test(text)) planInputs.push({sql:text.replace(/^DECLARE .*? FOR /,''),params});
            }
            return result;
          }};
        }}};
        const start=performance.now();
        try {
          const page=await loadListingPage(input,{driver:'postgres',pgDriver:counted});
          if(measure) for(const [key,value] of Object.entries({...page.timing.stages,stats_ms:page.timing.stats_ms,
            ...Object.fromEntries(Object.entries(page.timing.stats_stages).map(([key,value])=>['stats_'+key,value]))})) {
            if(typeof value==='number' && key.endsWith('_ms')) (stageSamples[key] ||= []).push(value);
          }
          const serialized=JSON.stringify(page); // Include response serialization.
          if(page.stats.matched!==expected.matched||page.stats.total!==expected.total||page.stats.dbTotal!==expected.dbTotal
            || JSON.stringify(page.listings.map(r=>r.post_id))!==JSON.stringify(expected.pageIds)) {
            throw new Error('fixed fixture IDs or totals differ from the independent expected result');
          }
          const result=JSON.stringify({ids:page.listings.map(r=>r.post_id),matched:page.stats.matched,stats:page.stats});
          if(baseline!==null && baseline!==result) throw new Error('results changed across identical requests');
          baseline=result;
          if(serialized.length<100) throw new Error('missing complete response');
        } catch(error) {
          errors.push({code:error.code||null,message:String(error.message).slice(0,220)});
          if(!measure) throw error;
        } finally {
          const memory=process.memoryUsage();rss=Math.max(rss,memory.rss);heap=Math.max(heap,memory.heapUsed);
          if(measure){samples.push(performance.now()-start);queries.push(count);transactions.push(tx);}
        }
      }
      const {attempts}=await withoutSqliteIO(db,async()=>{
        const coldStart=performance.now();await request();
        const coldMs=performance.now()-coldStart;captureCold=false;
        // Diagnose PG versus Node cost outside all timed request windows.
        for(const query of planInputs) {
          const explained=await driver.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+query.sql,query.params);
          const snapshotPlan=await withPgReadSnapshot(driver,snapshot=>snapshot.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+query.sql,query.params));
          const summarize=plan=>({planningMs:plan['Planning Time'],executionMs:plan['Execution Time'],jit:plan.JIT||null,
            root:{node:plan.Plan['Node Type'],rows:plan.Plan['Actual Rows'],loops:plan.Plan['Actual Loops'],
              totalCost:plan.Plan['Total Cost'],sharedHitBlocks:plan.Plan['Shared Hit Blocks'],sharedReadBlocks:plan.Plan['Shared Read Blocks']}});
          coldPlans.push({sql:query.sql.replace(/\s+/g,' ').slice(0,180),default:summarize(explained.rows[0]['QUERY PLAN'][0]),
            requestSnapshot:summarize(snapshotPlan.rows[0]['QUERY PLAN'][0])});
        }
        for(let i=0;i<warms;i++) await Promise.all(Array.from({length:concurrency},()=>request()));
        const lag=monitorEventLoopDelay({resolution:10});lag.enable();await pause(20);
        const timer=setInterval(()=>{const m=process.memoryUsage();rss=Math.max(rss,m.rss);heap=Math.max(heap,m.heapUsed);},10);
        let next=0;
        try {
          await Promise.all(Array.from({length:concurrency},async()=>{while(next++<runs) await request(true);}));
          await pause(20);
        } finally {clearInterval(timer);lag.disable();}
        const result={scope,concurrency,requests:samples.length,coldMs,coldQueries,coldPlans,expected,
          resultSignature:createHash('sha256').update(baseline).digest('hex'),
          stageP95Ms:Object.fromEntries(Object.entries(stageSamples).map(([key,values])=>[key,percentile(values,.95)])),
          p50Ms:percentile(samples,.5),p95Ms:percentile(samples,.95),maxMs:Math.max(...samples),
          lagP99Ms:lag.percentile(99)/1e6,lagMaxMs:lag.max/1e6,rssPeakBytes:rss,heapPeakBytes:heap,
          queryCount:{min:Math.min(...queries),p50:percentile(queries,.5),max:Math.max(...queries)},
          transactionStatements:{min:Math.min(...transactions),max:Math.max(...transactions)},
          errorCount:errors.length,timeoutCount:errors.filter(e=>/timeout|timed out/i.test(e.message)).length,errors};
        result.ciSmokePassed=concurrency===1?result.p95Ms<=(scope==='single'?2000:4000)&&!errors.length:null;
        result.lagTargetMet=result.lagP99Ms<=50&&result.lagMaxMs<=100;
        result.nasLatencyPassed=target==='nas'?result.p95Ms<=({single:{1:1000,4:2000},all:{1:2000,4:4000}}[scope][concurrency])&&!errors.length:null;
        evidence.cases.push(result);save();console.log('PRB-PERF-CASE',JSON.stringify({...result,coldQueries:undefined,coldPlans:undefined}));
      });
      if(attempts.length) throw new Error(`SQLite I/O attempts: ${JSON.stringify(attempts)}`);
    }
    evidence.sqliteAttempts=0;
  });
  const ciPassed=evidence.cases.every(c=>c.errorCount===0&&c.ciSmokePassed!==false);
  const nasPassed=evidence.cases.every(c=>c.errorCount===0&&c.nasLatencyPassed&&c.lagTargetMet);
  evidence.status=target==='nas'?(nasPassed?'NAS_ACCEPTANCE_PASS':'NAS_ACCEPTANCE_FAIL'):(ciPassed?'CI_SMOKE_PASS':'CI_SMOKE_FAIL');
  evidence.nasAcceptance=target==='nas'?evidence.status:'NOT_RUN; CI does not verify NAS acceptance';
  save();console.log('PRB-PERF-RESULT',evidence.status,out);
  if(!['CI_SMOKE_PASS','NAS_ACCEPTANCE_PASS'].includes(evidence.status)) process.exitCode=1;
} catch(error) {
  evidence.status='FAILED';evidence.error={code:error.code||null,message:String(error.message)};save();throw error;
} finally {rmSync(dir,{recursive:true,force:true});}
