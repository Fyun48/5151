import { setImmediate as yieldToIO } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

// The synchronous reference and asynchronous PG path drain the same steps.
// A checkpoint changes scheduling, never candidate limits or traversal order.
export function runStepsSync(steps) {
  let step;
  do { step = steps.next(); } while (!step.done);
  return step.value;
}

export async function runStepsAsync(steps, { budgetMs = 3 } = {}) {
  let deadline = performance.now() + budgetMs;
  while (true) {
    const step = steps.next();
    if (step.done) return step.value;
    if (performance.now() >= deadline) {
      await yieldToIO();
      deadline = performance.now() + budgetMs;
    }
  }
}

export function* transformChunks(rows, transform, size = 256) {
  const result = [];
  for (let start = 0; start < rows.length; start += size) {
    result.push(...transform(rows.slice(start, start + size)));
    yield;
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
    yield;
  }
  let target = new Array(source.length);
  for (let width = size; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += 2 * width) {
      const middle = Math.min(start + width, source.length);
      const end = Math.min(start + 2 * width, source.length);
      let left = start, right = middle;
      for (let index = start; index < end; index++) {
        target[index] = right >= end || (left < middle && compare(source[left], source[right]) <= 0)
          ? source[left++] : source[right++];
        if (index % size === 0) yield;
      }
    }
    [source, target] = [target, source];
  }
  return source;
}
