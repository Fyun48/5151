import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToIO } from 'node:timers/promises';

// Opt-in, bounded aggregates. The benchmark owns one collector per case; normal
// requests retain no samples and concurrent callers cannot replace its scope.
const context = new AsyncLocalStorage();
export const currentWorkDiagnostics = () => context.getStore();
export const withWorkDiagnostics = (collector, run) => context.run(collector, run);

export function createWorkDiagnostics() {
  const metrics = new Map();
  const slowEvents = new Map();
  const traced = new Set(['gc.pause','eventLoop.tickGap','pg.fetch.wall','pg.fetch.yieldWait']);
  return {
    record(label, ms, units = 0, started = null) {
      let value = metrics.get(label);
      if (!value) {
        value = { calls: 0, totalMs: 0, maxMs: 0, totalUnits: 0, maxUnits: 0,
          over2Ms: 0, over10Ms: 0, over50Ms: 0 };
        metrics.set(label, value);
      }
      value.calls++;
      value.totalMs += ms;
      value.maxMs = Math.max(value.maxMs, ms);
      value.totalUnits += units;
      value.maxUnits = Math.max(value.maxUnits, units);
      if (ms > 2) value.over2Ms++;
      if (ms > 10) value.over10Ms++;
      if (ms > 50) value.over50Ms++;
      if (ms >= 20 && traced.has(label)) {
        const events = slowEvents.get(label) || [];
        // Keep at most 32 longest spans per category, not an unbounded trace.
        if (events.length < 32 || ms > events.at(-1).ms) {
          const startMs = started ?? performance.now() - ms;
          events.push({startMs,endMs:startMs + ms,ms,units});
          events.sort((a,b)=>b.ms-a.ms);
          if (events.length > 32) events.pop();
          slowEvents.set(label,events);
        }
      }
    },
    snapshot() {
      return Object.fromEntries([...metrics].map(([key, value]) => [key, { ...value,
        totalMs: +value.totalMs.toFixed(3), maxMs: +value.maxMs.toFixed(3) }]));
    },
    timeline() {
      return Object.fromEntries([...slowEvents].map(([label,events])=>[label,events.map(e=>({...e}))]));
    },
  };
}

export async function yieldWork(label) {
  const collector = currentWorkDiagnostics();
  if (!collector) return yieldToIO();
  const started = performance.now();
  await yieldToIO();
  // Time waiting for the scheduler includes OTHER requests and I/O; it is not
  // this caller's synchronous execution time. Keep it separate from step/slice.
  collector.record(`${label}.yieldWait`, performance.now() - started, 0, started);
}
