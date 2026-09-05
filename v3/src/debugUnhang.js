/** Temporary hang instrumentation. Remove after the NAS CPU/event-loop investigation. */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const ENABLED = process.env.DEBUG_UNHANG !== "0";
const CURSOR_LOG = "/opt/cursor/logs/debug.log";
const DATA_LOG = path.join(process.env.DATA_DIR || path.join(process.cwd(), "data-v3"), "debug-unhang.ndjson");

let phase = "boot";
let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();
const aggs = new Map();

function safeMkdir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
}

function appendLine(file, line) {
  try {
    appendFileSync(file, line);
    return true;
  } catch {
    return false;
  }
}

function cpuSample() {
  const now = Date.now();
  const diff = process.cpuUsage(lastCpu);
  const elapsedMs = Math.max(1, now - lastCpuAt);
  lastCpu = process.cpuUsage();
  lastCpuAt = now;
  const cpuMs = (diff.user + diff.system) / 1000;
  return {
    userMs: Math.round(diff.user / 1000),
    systemMs: Math.round(diff.system / 1000),
    elapsedMs,
    cpuPct: Math.round((cpuMs / elapsedMs) * 100),
  };
}

function memSample() {
  const mem = process.memoryUsage();
  return { rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576) };
}

export function setUnhangPhase(next, extra = {}) {
  phase = String(next || "idle");
  unhangLog({
    hypothesisId: "H0",
    location: "debugUnhang.js:setUnhangPhase",
    message: "phase",
    data: { phase, ...extra },
  });
}

export function currentUnhangPhase() {
  return phase;
}

export function unhangLog({ hypothesisId, location, message, data = {}, runId = "pre-fix" }) {
  if (!ENABLED) return;
  const row = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    iso: new Date().toISOString(),
    location,
    message,
    data,
    hypothesisId,
    runId,
    phase,
    uptimeSec: Math.round(process.uptime()),
  };
  const line = `${JSON.stringify(row)}\n`;
  // #region agent log
  safeMkdir(path.dirname(CURSOR_LOG));
  appendLine(CURSOR_LOG, line);
  safeMkdir(path.dirname(DATA_LOG));
  appendLine(DATA_LOG, line);
  const bits = Object.entries(data)
    .slice(0, 14)
    .map(([key, value]) => `${key}=${typeof value === "object" && value !== null ? JSON.stringify(value) : value}`)
    .join(" ");
  console.log(`[unhang] ${row.iso} ${location} ${message} ${bits}`.trim());
  // #endregion
}

export function unhangAgg(key, meta, sample, { every = 25, slowMs = 40 } = {}) {
  let agg = aggs.get(key);
  if (!agg) {
    agg = { n: 0, ms: 0, maxMs: 0, slow: 0 };
    aggs.set(key, agg);
  }
  const ms = Number(sample?.ms) || 0;
  agg.n += 1;
  agg.ms += ms;
  agg.maxMs = Math.max(agg.maxMs, ms);
  if (ms >= slowMs) agg.slow += 1;
  if (ms >= slowMs || agg.n % every === 0) {
    unhangLog({
      hypothesisId: meta.hypothesisId,
      location: meta.location,
      message: meta.message,
      data: { ...agg, last: sample },
    });
  }
}

export function startUnhangProbe() {
  if (!ENABLED || startUnhangProbe.started) return;
  startUnhangProbe.started = true;
  let expected = Date.now() + 1000;
  let lastOk = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    const lagMs = now - expected;
    expected = now + 1000;
    const noisy = lagMs > 250 || now - lastOk >= 5000;
    if (!noisy) return;
    lastOk = now;
    unhangLog({
      hypothesisId: "H0",
      location: "debugUnhang.js:probe",
      message: lagMs > 250 ? "event-loop-lag" : "event-loop-ok",
      data: { lagMs, ...cpuSample(), ...memSample() },
    });
  }, 1000);
  timer.unref?.();
  unhangLog({
    hypothesisId: "H0",
    location: "debugUnhang.js:probe",
    message: "probe-start",
    data: { cursorLog: CURSOR_LOG, dataLog: DATA_LOG, ...memSample() },
  });
}
