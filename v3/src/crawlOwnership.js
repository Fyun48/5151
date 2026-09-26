import { AsyncLocalStorage } from 'node:async_hooks';
import { currentCrawlExecution, withCrawlExecution } from './crawlExecution.js';

const ownership = new AsyncLocalStorage();
const transactionScope = new AsyncLocalStorage();
// PostgreSQL advisory locks are scoped to the current database. This pair is
// reserved for the 5151 crawler, not for migrations or other applications.
export const CRAWL_LOCK_KEYS = [5151, 20260926];
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
