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

// 解鎖前等待「已送出的語句」收尾的上限（毫秒）。
//
// 為什麼需要上限：舊寫法在 finally 裡無上限地 `await owner.tail`，只要那筆語句永遠
// 不回來，解鎖就永遠送不出去（2026-10-12 正式站 advisory lock 洩漏事故）。超過這個
// 上限就放棄等待，直接銷毀該 session——session 級 advisory lock 只在 session 結束時
// 才保證釋放（那是唯一的保證）。
export const CRAWL_UNLOCK_WAIT_MS = 5000;

// 「離開時無法確認 advisory lock 已釋放」的累計次數。正常永遠是 0；
// 接到 `/api/health` 的 `crawl_owner_unlock_failures`，每一筆同時寫一行容器日誌。
let releaseUnconfirmed = 0;
export const crawlOwnerReleaseStats = () => ({ unlock_unconfirmed: releaseUnconfirmed });

/** 等 `tail` 收尾，最多等 `timeoutMs`；回傳是否已收尾（沒收尾就不能再對這條連線送查詢）。 */
async function waitForTail(tail, timeoutMs) {
  const ms = Math.max(0, Number(timeoutMs) || 0);
  let timer;
  const expired = new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); });
  try {
    // `owner.tail` 一律是接過錯的鏈，所以只會 resolve。
    return (await Promise.race([tail.then(() => true), expired])) === true;
  } finally {
    clearTimeout(timer);
  }
}

export async function withPgCrawlOwner(driver, work, { signal, unlockWaitMs = CRAWL_UNLOCK_WAIT_MS } = {}) {
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
    // 2026-10-12（正式站 owner advisory lock 洩漏）：釋放必須是 guarantee，不能只是「盡量」。
    //
    // 舊寫法是無上限的 `await owner.tail`（等一筆已送出的語句收尾）之後才送
    // `pg_advisory_unlock`，而且從不檢查解鎖結果；只要那筆語句永遠不回來，這個 finally
    // 就永遠停在這裡 ⇒ 解鎖永遠沒送出 ⇒ session 級鎖被留到容器重啟為止，另一節點每
    // 60 秒只能回 `owner_busy`（正式站實查：持有者 `state=idle in transaction`、
    // 最後一句 `SAVEPOINT revision_bump`）。
    //
    // 新契約：**只有在同一條連線上拿到 `pg_advisory_unlock = true`，才可以把這條連線
    // 放回池**。等不到收尾、解鎖丟錯、或回 false，都算「無法確認」，直接銷毀該 session
    // ——session 級鎖只在 session 結束時保證釋放，連線銷毀就是那個保證。
    const settled=await waitForTail(owner.tail,unlockWaitMs);
    let released=false,reason=null;
    if(!settled) reason=`已送出的語句在 ${unlockWaitMs}ms 內沒有收尾`;
    else if(acquired && broken) reason='連線已標記為中斷';
    else if(acquired) {
      try {
        // 同一條連線（`client`）解鎖；換條連線會回 false 且鎖會留在原 session。
        const result=await client.query('SELECT pg_advisory_unlock($1,$2) AS released',CRAWL_LOCK_KEYS);
        released=result.rows[0]?.released===true;
        if(!released) reason='pg_advisory_unlock 回報 false（這條連線沒有這把鎖）';
      } catch (error) { reason=`pg_advisory_unlock 失敗：${error?.message||error}`; }
    }
    const destroy=!settled||(Boolean(acquired)&&!released);
    if(Boolean(acquired)&&!released) {
      releaseUnconfirmed+=1;
      console.error(`[crawl-owner] 無法確認 advisory lock 已釋放（${reason}）；銷毀該 PG session 以保證釋放（(5151,20260926)），累計 ${releaseUnconfirmed} 次`);
    } else if(!settled) {
      // 沒有拿到鎖（owner_busy）但語句沒收尾：連線的乾淨程度無法確認，一樣銷毀，不放回池。
      console.error(`[crawl-owner] ${reason}；銷毀該 PG session（沒有拿到鎖，但不把沒收尾的連線放回池）`);
    }
    client.removeListener('error',onError);
    client.release(destroy||broken);
  }
}
