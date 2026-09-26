import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../scripts/prb-nas-verify.sh', import.meta.url));
const sha = 'a'.repeat(40);

// Exercise the actual Bash EXIT trap and Linux process groups. Docker and git
// are local fakes: no daemon, network, production data, or real worktree needed.
for (const outcome of ['success', 'failure', 'term']) {
  test(`NAS runner cleans a TERM-resistant sampler and preserves ${outcome}`, {
    skip: process.platform !== 'linux', timeout: 15000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prb-runner-test-'));
    const log = join(dir, 'docker.log');
    const ready = join(dir, 'sampler.pid');
    const fakeDocker = `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.PRB_TEST_LOG, JSON.stringify(a) + '\\n');
if (a[0] === 'inspect') console.log(a.includes('{{.State.Health.Status}}') ? 'healthy' : 'sha256:fake');
else if (a[0] === 'image') console.log('sha256:fake');
else if (a[0] === 'stats') {
  if (!a.includes('--no-stream')) process.exit(90);
  process.on('SIGTERM', () => {});
  console.log(JSON.stringify({Name: a.at(-1), CPUPerc: '1.0%'}));
  fs.writeFileSync(process.env.PRB_TEST_READY, String(process.pid));
  setInterval(() => {}, 1000);
} else if (a[0] === 'run' && a.includes('PERF_TARGET=nas')) {
  const deadline = Date.now() + 5000;
  const timer = setInterval(() => {
    if (!fs.existsSync(process.env.PRB_TEST_READY)) {
      if (Date.now() > deadline) process.exit(91);
      return;
    }
    clearInterval(timer);
    if (process.env.PRB_TEST_OUTCOME === 'term') process.kill(process.ppid, 'SIGTERM');
    process.exit(process.env.PRB_TEST_OUTCOME === 'failure' ? 1 : 0);
  }, 10);
}
`;
    writeFileSync(join(dir, 'docker'), fakeDocker, { mode: 0o755 });
    writeFileSync(join(dir, 'git'), '#!/bin/bash\nif [[ "$1" == rev-parse ]]; then printf "%s\\n" "$PRB_TEST_ROOT"; fi\n', { mode: 0o755 });
    const child = spawn('bash', [runner, sha, join(dir, 'out')], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir,
        PRB_TEST_ROOT: dir, PRB_TEST_LOG: log, PRB_TEST_READY: ready, PRB_TEST_OUTCOME: outcome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', b => { output += b; });
    child.stderr.on('data', b => { output += b; });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.equal(code, outcome === 'term' ? 143 : outcome === 'failure' ? 1 : 0, output);
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      const sample = JSON.parse(readFileSync(join(dir, 'out/postgres-resource-stats.jsonl'), 'utf8').trim());
      assert.match(sample.Name, /^prb-verify-.*-pg$/);
      assert.ok(calls.some(a => a[0] === 'rm' && a[1] === '-f' && a.includes(sample.Name)));
      assert.ok(calls.some(a => a[0] === 'network' && a[1] === 'rm'));
      assert.ok(calls.some(a => a[0] === 'volume' && a[1] === 'rm'));
      assert.ok(calls.filter(a => a[0] === 'stats').every(a => a.at(-1) === sample.Name));
      const pid = readFileSync(ready, 'utf8').trim();
      // A killed grandchild may briefly be a zombie until PID 1 reaps it.
      const status = `/proc/${pid}/status`;
      if (existsSync(status)) assert.match(readFileSync(status, 'utf8'), /State:\s+Z/);
    } finally {
      clearTimeout(deadline);
      if (existsSync(ready)) {
        try { process.kill(Number(readFileSync(ready, 'utf8')), 'SIGKILL'); } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
