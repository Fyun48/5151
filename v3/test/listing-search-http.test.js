import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
const dir=mkdtempSync(path.join(os.tmpdir(),'prb-http-'));
process.env.DATA_DIR=dir;
const {loadListingPage}=await import('../src/listingSearchPage.js');
const {sendListingSearchUnavailable}=await import('../src/listingSearchHttp.js');
after(()=>rmSync(dir,{recursive:true,force:true}));

test('HTTP search failure returns 503 and a stable code without database details',async()=>{
  const app=express();
  app.get('/api/listings',async(_req,res)=>{
    try {
      const pgDriver={query:async()=>{throw Object.assign(new Error('sensitive database detail'),{code:'42P01'});}};
      res.json(await loadListingPage({userId:0,settings:{}},{driver:'postgres',pgDriver}));
    } catch(error) {
      if(!sendListingSearchUnavailable(res,error)) throw error;
    }
  });
  const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/listings`);
    assert.equal(response.status,503);
    const body=await response.json();
    assert.equal(body.code,'SEARCH_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(body),/sensitive|42P01/);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
