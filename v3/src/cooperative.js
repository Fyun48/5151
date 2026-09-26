import { performance } from 'node:perf_hooks';
import { currentWorkDiagnostics, yieldWork } from './workDiagnostics.js';

// The synchronous reference and asynchronous PG path drain the same steps.
// A checkpoint changes scheduling, never candidate limits or traversal order.
export function runStepsSync(steps) {
  let step;
  do { step = steps.next(); } while (!step.done);
  return step.value;
}

export async function runStepsAsync(steps, { budgetMs = 2, label = 'cooperative' } = {}) {
  const diagnostics = currentWorkDiagnostics();
  let sliceStarted = performance.now();
  let deadline = sliceStarted + budgetMs;
  let units = 0;
  while (true) {
    const started = diagnostics ? performance.now() : 0;
    const step = steps.next();
    const now = performance.now();
    const count = step.done ? 0 : step.value?.units || 0;
    units += count;
    diagnostics?.record(`${step.done ? label : step.value?.label || label}.step`, now - started, count);
    if (step.done || now >= deadline) {
      diagnostics?.record(`${label}.slice`, now - sliceStarted, units);
      // A generator's final next() can do substantial work too. It must not
      // bypass the scheduling budget just because it returns instead of yields.
      if (now >= deadline) await yieldWork(label);
      if (step.done) return step.value;
      sliceStarted = performance.now();
      deadline = sliceStarted + budgetMs;
      units = 0;
    }
  }
}

export function* transformChunks(rows, transform, size = 256, label) {
  const result = [];
  for (let start = 0; start < rows.length; start += size) {
    const chunk = rows.slice(start, start + size);
    result.push(...transform(chunk));
    yield { units: chunk.length, label };
  }
  return result;
}

// Stable merge of small native sorts. Equal keys retain the input order just
// as Array.sort does, while large candidate sets permit timers and I/O to run.
export function* stableSortSteps(rows, compare, size = 256) {
  let source = [...rows];
  for (let start = 0; start < source.length; start += size) {
    const part = source.slice(start, start + size).sort(compare);
    for (let i = 0; i < part.length; i++) source[start + i] = part[i];
    yield {units:part.length};
  }
  let target = new Array(source.length);
  for (let width = size; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += 2 * width) {
      const middle = Math.min(start + width, source.length);
      const end = Math.min(start + 2 * width, source.length);
      let left = start, right = middle;
      let units = 0;
      for (let index = start; index < end; index++) {
        target[index] = right >= end || (left < middle && !(compare(source[left], source[right]) > 0))
          ? source[left++] : source[right++];
        if (++units === size) { yield {units}; units = 0; }
      }
      if (units) yield {units};
    }
    [source, target] = [target, source];
  }
  return source;
}
