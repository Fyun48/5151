import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

test('member search failure preserves the visible results, counters, filters and pagination', async()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const code=html.slice(html.indexOf('async function loadList(options = {})'),html.indexOf('async function loadState()'));
  let paints=0;
  const context=createContext({
    window:{},isGuest:false,listLoadGen:0,listRefreshQueued:false,
    watchNoteBusy:()=>false,setListBusy:()=>{},canFilterSources:()=>false,
    listCache:[{post_id:42}],lastStats:{matched:9},listHasMore:true,listOffset:50,listCursor:{id:42},
    settings:{priceMax:18000},filter:'all',kinds:[],sources:[],sort:'newest',viewDistricts:new Set(['中山區']),
    LIST_PAGE_SIZE:50,performance,$:()=>({value:'保留查詢'}),
    renderStats:()=>paints++,renderDistrictChips:()=>paints++,renderList:()=>paints++,
    fetch:async()=>({ok:false,status:503,json:async()=>({error:'暫時無法連線，請重試',code:'SEARCH_UNAVAILABLE'})}),
  });
  runInContext(code,context);
  await assert.rejects(()=>context.loadList({silent:true}),error=>error.code==='SEARCH_UNAVAILABLE');
  assert.equal(paints,0);
  assert.equal(context.listCache[0].post_id,42);
  assert.equal(context.lastStats.matched,9);
  assert.equal(context.settings.priceMax,18000);
  assert.equal(context.listOffset,50);
  assert.equal(context.listCursor.id,42);
  assert.equal(context.listHasMore,true);
});
