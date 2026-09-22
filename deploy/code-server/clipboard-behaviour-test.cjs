'use strict';
// clipboard-behaviour-test.cjs <original-bundle> <patched-bundle>
//
// Extracts the REAL catch-block text of BrowserClipboardService#readText from
// both bundles, wraps it in a minimal harness with stubbed VS Code services and
// a Chromium that DENIES navigator.clipboard.readText(), and measures what a
// caller (terminal/editor paste, extension, Cline's env.clipboardReadText RPC)
// experiences.
const fs = require('fs');

const [origFile, patchedFile] = process.argv.slice(2);
const MSG_KEY = 'd(20492,null)';
const END_MARK = 'i("")))})}';
const PATCH_MARK = '/*clipboard-fail-open*/';
const REPL_END = 'return ""}';

function originalCatchBlock(file) {
    const s = fs.readFileSync(file, 'utf8');
    const m = s.indexOf(MSG_KEY);
    const st = s.lastIndexOf('}catch{return new Promise(', m) + 1;
    const en = s.indexOf(END_MARK, m) + END_MARK.length;
    return s.slice(st, en);
}
function patchedCatchBlock(file) {
    const s = fs.readFileSync(file, 'utf8');
    const p = s.indexOf(PATCH_MARK);
    return s.slice(p, s.indexOf(REPL_END, p) + REPL_END.length);
}

function buildHarness(catchSrc, env) {
    const body = `
        return class BrowserClipboardService {
            constructor(env) { Object.assign(this, env); }
            async readText(e) {
                try { return await globalThis.navigator.clipboard.readText(); }
                ${catchSrc}
            }
        };`;
    const factory = new Function('A', 'K', 'Ct', 'd', body);
    return factory(env.A, env.K, env.Ct, env.d);
}

class DisposableStore { add() { } dispose() { } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(label, catchSrc) {
    const prompts = [];
    const logs = [];
    const opened = [];
    const onCloseCallbacks = [];
    const K = { once: () => (cb) => { onCloseCallbacks.push(cb); return { dispose() { } }; } };
    const Ct = { Error: 1 };
    const d = (id) => 'nls:' + id;

    Object.defineProperty(globalThis.navigator, 'clipboard', {
        configurable: true,
        writable: true,
        value: {
            readText: async () => {
                const err = new Error('NotAllowedError: Failed to execute readText on Clipboard: Write permission denied.');
                err.name = 'NotAllowedError';
                throw err;                       // <-- what Chromium does to code-server
            },
        },
    });

    const Svc = buildHarness(catchSrc, { A: DisposableStore, K, Ct, d });
    const svc = new Svc({
        logService: { trace() { }, error(...a) { logs.push(a.map(String).join(' ')); } },
        notificationService: {
            prompt(severity, message, actions, opts) {
                prompts.push({ severity, message, actions: actions.map((a) => a.label), opts });
                return { onDidClose: {} };
            },
        },
        openerService: { open(u) { opened.push(u); } },
    });

    let settled = null;
    const p = svc.readText().then((v) => { settled = v; });

    await wait(400);
    const pendingAfter400ms = settled === null;          // caller is blocked
    const retryAction = prompts[0] && prompts[0].actions && prompts[0].actions[0];

    console.log('=== ' + label + ' ===');
    console.log('  clipboard was denied by the browser (NotAllowedError)');
    console.log('  caller still blocked after 400ms      : ' + pendingAfter400ms);
    console.log('  error toast shown to the user         : ' + (prompts.length > 0 ? 'YES ' + JSON.stringify(prompts[0].actions) : 'no'));
    console.log('  log-level warning recorded            : ' + (logs.length > 0 ? 'YES ("' + logs[0] + '")' : 'no'));
    console.log('  promises pending (unresolved awaits)  : ' + (pendingAfter400ms ? 1 : 0));

    if (prompts.length === 0) {
        console.log('  RESULT: fail-open -> readText() resolved with ' + JSON.stringify(settled) + ', agent keeps running');
        return { blocked: false, resolved: settled };
    }

    console.log('  -> the ONLY way the await ever settles is human action:');
    console.log('     clicking "' + retryAction + '" or dismissing the toast');
    console.log('  RESULT: blocking Retry gate -> Cline agent task is stuck here');
    onCloseCallbacks.forEach((cb) => cb());   // user finally dismisses the toast
    await p;
    return { blocked: true, resolved: settled };
}

(async () => {
    const patched = await run('BEFORE FIX (container-image bundle)', originalCatchBlock(origFile));
    console.log();
    const fixed = await run('AFTER FIX (patched bundle, serving now)', patchedCatchBlock(patchedFile));
    console.log();
    const ok = patched.blocked === true && patched.resolved === '' &&
        fixed.blocked === false && fixed.resolved === '';
    console.log(ok ? 'OVERALL: PASS (bug reproduced before, gone after)'
        : 'OVERALL: FAIL');
    process.exit(ok ? 0 : 1);
})();
