import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getCachedPublicListings,resetPublicListingsCache,publicListingsCacheSize} from '../src/publicListings.js';

test('public cache awaits success, preserves rejection, and separates cache generations', async()=>{
  resetPublicListingsCache();
  await assert.rejects(()=>getCachedPublicListings({},async()=>{throw new Error('database unavailable');}));
  assert.equal(publicListingsCacheSize(),0);
  const first=await getCachedPublicListings({},async()=>({listings:[1]}),{namespace:'test:v1'});
  assert.deepEqual(first.listings,[1]);
  const hit=await getCachedPublicListings({},async()=>assert.fail('must reuse success'),{namespace:'test:v1'});
  assert.equal(hit.cache_hit,true);
  const next=await getCachedPublicListings({},async()=>({listings:[2]}),{namespace:'test:v2'});
  assert.deepEqual(next.listings,[2]);
  assert.equal(next.cache_hit,false);
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
