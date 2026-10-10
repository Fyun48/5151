import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getCachedPublicListings,resetPublicListingsCache,publicListingsCacheSize} from '../src/publicListings.js';

test('public cache awaits success, preserves rejection, and serves stale across generations', async()=>{
  resetPublicListingsCache();
  await assert.rejects(()=>getCachedPublicListings({},async()=>{throw new Error('database unavailable');}));
  assert.equal(publicListingsCacheSize(),0);
  const first=await getCachedPublicListings({},async()=>({listings:[1]}),{namespace:'test:v1'});
  assert.deepEqual(first.listings,[1]);
  assert.equal(first.cache_hit,false);
  const hit=await getCachedPublicListings({},async()=>assert.fail('must reuse success'),{namespace:'test:v1'});
  assert.equal(hit.cache_hit,true);
  // generation 換代但 entry 仍年輕（≤ MAX_STALE_MS）：SWR 先回舊值＋背景重算，不當下重算。
  const next=await getCachedPublicListings({},async()=>({listings:[2]}),{namespace:'test:v2'});
  assert.deepEqual(next.listings,[1]);
  assert.equal(next.cache_hit,true);
  assert.equal(next.stale,true);
});

test('unversioned PG requests read fresh results and never reuse a SQLite cache entry', async()=>{
  resetPublicListingsCache();
  getCachedPublicListings({},()=>({listings:['sqlite']}));
  for(const id of [1,2]) {
    const result=await getCachedPublicListings({},async()=>({listings:[id]}),{namespace:null});
    assert.deepEqual(result.listings,[id]);
    assert.equal(result.cache_hit,false);
  }
});
