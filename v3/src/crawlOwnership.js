import { AsyncLocalStorage } from 'node:async_hooks';
import { currentCrawlExecution, withCrawlExecution } from './crawlExecution.js';

const ownership = new AsyncLocalStorage();
const transactionScope = new AsyncLocalStorage();
// PostgreSQL advisory locks are scoped to the current database. This pair is
// reserved for the 5151 crawler, not for migrations or other applications.
export const CRAWL_LOCK_KEYS = [5151, 20260926];
// 持有連線的心跳間隔。必須明顯小於 HAProxy 的 `timeout client 30s`（正式站目前 30 秒），
// 否則閒置的持有連線會被切斷。設 0 可停用（例如無 Proxy 直連 PG 的環境）。
export const CRAWL_HEARTBEAT_MS = (() => {
  const raw = Number(process.env.PG_CRAWL_HEARTBEAT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10000;
})();
export const currentCrawlOwner = () => ownership.getStore();

export async function withPgCrawlOwner(driver, work, { signal } = {}) {
  signal?.throwIfAborted();
  const client = await driver.pool.connect();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
  const parent = currentCrawlExecution();
  let acquired=false, broken=false, onAbort;
  const owner = {pool:driver.pool,client,closed:false,tail:Promise.resolve(),
    assertActive() {
      combined.throwIfAborted();
      if(this.closed) throw new Error('Crawler ownership has ended');
    },
    transact(fn) {
      this.assertActive();
      if(transactionScope.getStore()===this) throw new Error("Nested crawler transaction: use the existing transaction client");
      const result=this.tail.then(()=>{this.assertActive();return transactionScope.run(this,()=>fn(client));});
      this.tail=result.catch(()=>{});
      return result;
    },
  };
  const onError=error=>{broken=true;controller.abort(error);};
  client.on('error',onError);
  // 2026-09-27：正式站的 crawler 每次都在 30 秒後失敗，根因就是這一條連線。
  //
  // withPgCrawlOwner() 為了持有 session 級 advisory lock，會借出這條連線並實質持有
  // 「整個 crawl」——包含前段完全不碰 DB 的網路抓取。HAProxy（App → HAProxy → PG）
  // 設了 `timeout client 30s`：應用端 30 秒沒送出任何資料就切斷連線（實測終止代碼 `cD`）。
  // 而這條連線是**已借出**、不是池中閒置，所以 node-postgres 的 idleTimeoutMillis
  // 不會回收它。結果就是抓取階段一超過 30 秒，連線被切斷，crawl 之後第一次寫入
  // 就丟出 `Connection terminated unexpectedly`，每一輪都一樣，crawler 永遠跑不完。
  //
  // 心跳刻意排進 owner.tail 這條既有的序列化佇列，因此**不可能與交易重疊**：
  // 它只會在某筆交易完成之後、下一筆開始之前執行。
  let heartbeatTimer=null;
  if (CRAWL_HEARTBEAT_MS>0) {
    heartbeatTimer=setInterval(()=>{
      owner.tail=owner.tail.then(async()=>{
        if(owner.closed||broken) return;
        try { await client.query('SELECT 1'); }
        catch (error) { broken=true; controller.abort(error); }
      }).catch(()=>{});
    },CRAWL_HEARTBEAT_MS);
    // 不要因為這個計時器讓 process 無法結束。
    heartbeatTimer.unref?.();
  }
  try {
    combined.throwIfAborted();
    const result=await client.query('SELECT pg_try_advisory_lock($1,$2) AS acquired',CRAWL_LOCK_KEYS);
    acquired=result.rows[0]?.acquired===true;
    combined.throwIfAborted();
    if(!acquired) return {skipped:'owner_busy',checked_at:new Date().toISOString(),searches:[],events:[]};
    const cancelled=new Promise((_,reject)=>{
      onAbort=()=>reject(combined.reason);
      combined.addEventListener('abort',onAbort,{once:true});
    });
    const execution=parent ? {...parent,signal:combined,assertOwner:()=>owner.assertActive()} : null;
    const running=ownership.run(owner,async()=>execution ? withCrawlExecution(execution,work) : work());
    return await Promise.race([running,cancelled]);
  } finally {
    owner.closed=true;
    if(heartbeatTimer) clearInterval(heartbeatTimer);
    controller.abort(new Error('Crawler ownership has ended'));
    if(onAbort) combined.removeEventListener('abort',onAbort);
    // Wait for an in-flight statement to roll back before unlocking or returning
    // this connection to the pool. Late callbacks fail assertActive, not enqueue.
    await owner.tail;
    if(acquired && !broken) {
      try { await client.query('SELECT pg_advisory_unlock($1,$2)',CRAWL_LOCK_KEYS); }
      catch { broken=true; }
    }
    client.removeListener('error',onError);
    client.release(broken);
  }
}
