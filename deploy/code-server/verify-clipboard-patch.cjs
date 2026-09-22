'use strict';
// verify-clipboard-patch.cjs <orig> <patched> [...more pairs]
// Proves the patch is minimal: the patched file must be byte-identical to the
// original except for the single catch-block of BrowserClipboardService#readText.
const fs = require('fs');

const MSG_KEY = 'd(20492,null)';
const START_MARK = '}catch{return new Promise(';
const END_MARK = 'i("")))})}';
const PATCH_MARK = '/*clipboard-fail-open*/catch(__clipErr){';
const REPL_END = 'return ""}';

const args = process.argv.slice(2);
let fail = 0;

for (let a = 0; a + 1 < args.length; a += 2) {
    const orig = fs.readFileSync(args[a], 'utf8');
    const patched = fs.readFileSync(args[a + 1], 'utf8');

    const msg = orig.indexOf(MSG_KEY);
    const start = orig.lastIndexOf(START_MARK, msg);
    const end = orig.indexOf(END_MARK, msg) + END_MARK.length;
    const region = orig.slice(start + 1, end);

    const m = patched.indexOf(PATCH_MARK);
    if (msg < 0 || start < 0 || end <= 0 || m < 0) {
        console.log('FAIL  pattern/marker missing for ' + args[a + 1]);
        fail = 1;
        continue;
    }
    const replLen = m + patched.slice(m).indexOf(REPL_END) + REPL_END.length - m;
    const repl = patched.slice(m, m + replLen);

    const prefixOk = patched.slice(0, m) === orig.slice(0, start + 1);
    const suffixOk = patched.slice(m + replLen) === orig.slice(end);
    const markerCount = patched.split(PATCH_MARK).length - 1;

    // the (former) blocking toast must be gone *at the patch site*
    const localAfter = patched.slice(Math.max(0, m - 40), m + replLen + 40);
    const localClean = !/20492|20494|20493|2151362|sticky/.test(localAfter);

    // global bookkeeping: exactly one Retry-label occurrence must have vanished
    const cnt = (s, t) => s.split(t).length - 1;
    const retryOrig = cnt(orig, 'd(20494,null)');
    const retryPatched = cnt(patched, 'd(20494,null)');
    const retryDelta = retryOrig - retryPatched;

    const ok = prefixOk && suffixOk && markerCount === 1 && localClean && retryDelta === 1;

    console.log((ok ? 'PASS  ' : 'FAIL  ') + args[a + 1]);
    console.log('      bytes: ' + orig.length + ' -> ' + patched.length +
        '  (region ' + region.length + ' chars -> ' + repl.length + ' chars)');
    console.log('      prefix identical: ' + prefixOk + '   suffix identical: ' + suffixOk +
        '   patch sites: ' + markerCount);
    console.log('      patch site clean (no toast/Retry code): ' + localClean +
        '   Retry-label uses removed: ' + retryDelta + ' of ' + retryOrig);
    console.log('      BEFORE: ' + region);
    console.log('      AFTER : ' + repl);
    if (!ok) fail = 1;
}
process.exit(fail);
