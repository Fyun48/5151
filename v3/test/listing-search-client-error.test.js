import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

// 與 `index.html` 的 readApi() 同契約（只取這個測試需要的部分）。
async function readApi(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (res.status === 502 || res.status === 504 || res.status === 524) throw new Error('伺服器回應逾時，請稍候再試');
    throw new Error('伺服器沒有正確回應，請重新整理後再試');
  }
}

test('member search failure preserves the visible results, counters, filters and pagination', async()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const code=html.slice(html.indexOf('async function loadList(options = {})'),html.indexOf('async function loadState()'));
  let paints=0;
  const context=createContext({
    window:{},isGuest:false,listLoadGen:0,listRefreshQueued:false,
    watchNoteBusy:()=>false,setListBusy:()=>{},canFilterSources:()=>false,
    listCache:[{post_id:42}],lastStats:{matched:9},listHasMore:true,listOffset:50,listCursor:{id:42},
    settings:{priceMax:18000},filter:'all',kinds:[],sources:[],sort:'newest',viewDistricts:new Set(['中山區']),
    LIST_PAGE_SIZE:50,listPageSize:()=>50,performance,$:()=>({value:'保留查詢'}),
    renderStats:()=>paints++,renderDistrictChips:()=>paints++,renderList:()=>paints++,
    // 第八十九批：`loadList()` 改走 `readApi()`（非 JSON 要換成看得懂的訊息，而不是
    // `Unexpected token '<'`）⇒ 夾具要提供同一份 readApi 與 `text()`。
    readApi,
    fetch:async()=>({ok:false,status:503,text:async()=>JSON.stringify({error:'暫時無法連線，請重試',code:'SEARCH_UNAVAILABLE'})}),
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

test('member search 遇到 HTML 回應（proxy／HTML 500）顯示看得懂的訊息，不是 JSON 天書', async()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const code=html.slice(html.indexOf('async function loadList(options = {})'),html.indexOf('async function loadState()'));
  let paints=0;
  const context=createContext({
    window:{},isGuest:false,listLoadGen:0,listRefreshQueued:false,
    watchNoteBusy:()=>false,setListBusy:()=>{},canFilterSources:()=>false,
    listCache:[{post_id:42}],lastStats:{matched:9},listHasMore:true,listOffset:50,listCursor:{id:42},
    settings:{priceMax:18000},filter:'all',kinds:[],sources:[],sort:'newest',viewDistricts:new Set(['中山區']),
    LIST_PAGE_SIZE:50,listPageSize:()=>50,performance,$:()=>({value:'保留查詢'}),
    renderStats:()=>paints++,renderDistrictChips:()=>paints++,renderList:()=>paints++,
    readApi,
    fetch:async()=>({ok:false,status:500,text:async()=>'<!DOCTYPE html><html><body>Internal Server Error</body></html>'}),
  });
  runInContext(code,context);
  await assert.rejects(()=>context.loadList({silent:true}),error=>{
    assert.match(String(error.message),/伺服器沒有正確回應/);
    assert.doesNotMatch(String(error.message),/Unexpected token|<!DOCTYPE/);
    return true;
  });
  assert.equal(paints,0, '失敗時不得改動畫面');
  assert.equal(context.lastStats.matched,9);
});
