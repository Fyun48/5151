import test from 'node:test';
import assert from 'node:assert/strict';
import { runStepsSync, runStepsAsync, stableSortSteps, transformChunks } from '../src/cooperative.js';
import { createWorkDiagnostics, currentWorkDiagnostics, withWorkDiagnostics } from '../src/workDiagnostics.js';

test('cooperative sort preserves native ordering, stable ties and every row across merge boundaries', async () => {
  for (const length of [0, 1, 255, 256, 257, 1025, 4097]) {
    const rows = Array.from({length}, (_, id) => ({id, key:(id * 73) % 17}));
    for (const direction of [1, -1]) {
      const compare = (a,b) => direction * (a.key-b.key);
      const expected = [...rows].sort(compare);
      assert.deepEqual(runStepsSync(stableSortSteps(rows,compare)), expected);
      assert.deepEqual(await runStepsAsync(stableSortSteps(rows,compare)), expected);
      assert.deepEqual(rows.map(r=>r.id), Array.from({length},(_,i)=>i));
    }
    assert.deepEqual(await runStepsAsync(stableSortSteps(rows,()=>NaN)),rows);
  }
});

test('chunk scheduling yields to I/O while preserving transform order and errors', async () => {
  const rows = Array.from({length:1025}, (_,i)=>i);
  const transform = part => part.filter(n=>n%3).map(n=>n*2);
  let ioRan = false;
  setImmediate(()=>{ioRan=true;});
  const result = await runStepsAsync(transformChunks(rows,transform), {budgetMs:0});
  assert.equal(ioRan,true);
  assert.deepEqual(result,transform(rows));
  await assert.rejects(runStepsAsync(transformChunks(rows,()=>{throw new Error('invalid provider');})), /invalid provider/);
});

test('the final generator step obeys the scheduling budget and diagnostics stay in their async scope', async () => {
  const first = createWorkDiagnostics(), second = createWorkDiagnostics();
  let ioRan = false;
  setImmediate(() => { ioRan = true; });
  assert.equal(await runStepsAsync((function* () { return 42; })(), {budgetMs:0}), 42);
  assert.equal(ioRan, true, 'a returning final step must still yield when its budget expires');
  const rows = Array.from({length:1025}, (_,i) => i);
  await Promise.all([first, second].map((collector, index) => withWorkDiagnostics(collector, async () => {
    const result = await runStepsAsync(transformChunks(rows, part => part.map(n => n + index)),
      {budgetMs:0, label:`request${index}`});
    assert.deepEqual(result, rows.map(n => n + index));
    assert.equal(currentWorkDiagnostics(), collector);
  })));
  for (const [index, collector] of [first, second].entries()) {
    const metrics = collector.snapshot();
    assert.ok(Object.keys(metrics).every(key => key.startsWith(`request${index}.`)));
    assert.equal(metrics[`request${index}.step`].totalUnits, rows.length);
    assert.equal(metrics[`request${index}.step`].maxUnits, 256);
    assert.equal(metrics[`request${index}.yieldWait`].calls, 6);
    assert.equal(metrics[`request${index}.slice`].calls, 6);
    metrics[`request${index}.step`].calls = -1;
    assert.equal(collector.snapshot()[`request${index}.step`].calls, 6);
  }
  assert.equal(currentWorkDiagnostics(), undefined);
});
