#!/usr/bin/env bash
# clipboard-failopen.sh  (created 2026-09-22)
#
# ROOT CAUSE it fixes
# -------------------
# VS Code Web / code-server ships BrowserClipboardService.readText():
#
#   try { t = await navigator.clipboard.readText(); return t }
#   catch { return new Promise(resolve => {                       // <-- BLOCKING
#     const n = notificationService.prompt(Severity.Error, "Unable to read from the
#                browser's clipboard...", [
#       { label: "Retry",      run: async () => { n.dispose(); resolve(await this.readText(t)) } },
#       { label: "Learn More", run: () => openerService.open("https://go.microsoft.com/...2151362") }
#     ], { sticky: true });
#     n.add(once(r.onDidClose)(() => resolve("")));                // only settles on human action
#   })}
#
# When Chromium denies navigator.clipboard.readText() (permission not granted,
# document not focused, no user activation, blocked-sticky, ...) the returned
# Promise NEVER settles until a human presses "Retry" or dismisses the sticky
# toast. Every caller that awaits a clipboard read -- terminal/editor paste,
# extensions, and Cline's `env.clipboardReadText` RPC -- hangs with it, so the
# Cline agent task stalls waiting for a manual Retry.
#
# WHAT THIS SCRIPT DOES
# ---------------------
# Rewrites exactly that catch-block to fail-open:
#
#   catch (__clipErr) { this.logService.error("clipboard read failed (fail-open,
#       no Retry gate):", __clipErr); return "" }
#
# => no notification, no Retry button, no pending promise. A failed clipboard
#    read is just a warning; the caller (and the agent) keeps running.
#
# PROPERTIES
# ----------
# * idempotent  : patched files are detected via the "clipboard-fail-open" marker
# * cheap       : fast path = read stamp + stat the two bundles, then exit (few ms)
# * backed up   : pre-patch file copied to ~/.backups/clipboard-failopen-auto/
# * surgical    : only the catch-block of BrowserClipboardService#readText is touched
# * fail-safe   : if the expected pattern is absent (new code-server version),
#                 nothing is written and exit code is 1 (file left untouched)
# * rollback    : see the tail of this file
#
# Invoked automatically from ~/.bashrc so it self-heals after a container rebuild.
set -u

TOOLS="$HOME/.local/share/code-server/tools"
STAMP="$TOOLS/.clipboard-failopen.stamp"
LOG="$TOOLS/clipboard-failopen.log"

T1="/usr/lib/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.js"
T2="/usr/lib/code-server/lib/vscode/out/vs/workbench/workbench.web.main.internal.js"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG" 2>/dev/null || true; }

# keep the log small (self-managed rotation)
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 200000 ]; then
    tail -n 200 "$LOG" >"$LOG.tmp" 2>/dev/null && mv -f "$LOG.tmp" "$LOG" 2>/dev/null
fi

# ---- fast path: bundles unchanged since the last successful patch -> exit ----
sig=""
for f in "$T1" "$T2"; do
    if [ -f "$f" ]; then
        sig="${sig}$(stat -c '%s:%Y:' "$f" 2>/dev/null)"
    else
        sig="${sig}missing:"
    fi
done
if [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$sig" ]; then
    exit 0
fi

# ---- need a node runtime (write access to /usr/lib is via sudo -n) ----
NODE=""
for c in "$HOME/.local/node/bin/node" /usr/lib/code-server/lib/node; do
    [ -x "$c" ] && NODE="$c" && break
done
[ -z "$NODE" ] && NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then
    log "SKIP: no node runtime found"
    exit 1
fi

SUDO=""
[ "$(id -u)" != "0" ] && SUDO="sudo -n"
if [ -n "$SUDO" ] && ! $SUDO true 2>/dev/null; then
    log "SKIP: no passwordless sudo (cannot write $T1)"
    exit 1
fi

log "need patch: sudo='$SUDO' node='$NODE'"

PATCHER="$TOOLS/.patch-clipboard-failopen.cjs"
cat >"$PATCHER" <<'NODEEOF'
'use strict';
// Minimal, marker-driven surgery on BrowserClipboardService#readText.
const fs = require('fs');
const path = require('path');

const DONE_MARK = 'clipboard-fail-open';   // marker written into the patched file
const MSG_KEY = 'd(20492,null)';           // nls: "Unable to read from the browser's clipboard..."
const START_MARK = '}catch{return new Promise(';
const END_MARK = 'i("")))})}';
const REPLACEMENT =
    '/*clipboard-fail-open*/catch(__clipErr){this.logService.error(' +
    '"clipboard read failed (fail-open, no Retry gate):",__clipErr);return ""}';

const backupDir = path.join(process.env.HOME || '/tmp', '.backups', 'clipboard-failopen-auto');
let rc = 0;

for (const file of process.argv.slice(2)) {
    if (!fs.existsSync(file)) { console.log('MISSING   ' + file); continue; }
    const src = fs.readFileSync(file, 'utf8');

    if (src.includes(DONE_MARK)) { console.log('ALREADY   ' + file); continue; }

    const msg = src.indexOf(MSG_KEY);
    if (msg < 0) { console.log('NO-MARKER ' + file); rc = 1; continue; }

    const start = src.lastIndexOf(START_MARK, msg);
    const endHit = src.indexOf(END_MARK, msg);
    if (start < 0 || endHit < 0) { console.log('NO-PATTERN ' + file); rc = 1; continue; }
    const end = endHit + END_MARK.length;

    const region = src.slice(start + 1, end);
    const okRegion = region.startsWith('catch{return new Promise(') &&
        region.includes('sticky:!0') &&
        region.includes('20494') &&        // "Retry" button label
        region.includes('20493') &&        // "Learn More" button label
        region.includes('2151362');        // Learn More target URL
    if (!okRegion) { console.log('SANITY-FAIL ' + file); rc = 1; continue; }

    try {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.writeFileSync(
            path.join(backupDir, path.basename(file) + '.' + Date.now() + '.orig'),
            src
        );
    } catch (e) { console.log('BACKUP-WARN ' + e.message); }

    const out = src.slice(0, start + 1) + REPLACEMENT + src.slice(end);
    fs.writeFileSync(file, out);           // in-place write: keeps owner/mode of the target
    console.log('PATCHED   ' + file + ' (' + region.length + ' chars replaced)');
}
process.exit(rc);
NODEEOF

out=$($SUDO "$NODE" "$PATCHER" "$T1" "$T2" 2>&1)
rc=$?
log "rc=$rc $out"
[ $rc -ne 0 ] && exit $rc

printf '%s' "$sig" >"$STAMP" 2>/dev/null || true
log "stamp updated (browser reload required to load the patched bundle)"
exit 0

# ---------------------------------------------------------------------------
# ROLLBACK
#   1) restore the pristine bundles (container-image originals):
#        BK=$(ls -dt ~/.backups/clipboard-failopen-* | head -1)
#        sudo cp "$BK/workbench.js.orig" /usr/lib/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.js
#        sudo cp "$BK/workbench.web.main.internal.js.orig" /usr/lib/code-server/lib/vscode/out/vs/workbench/workbench.web.main.internal.js
#      (or use the auto backups in ~/.backups/clipboard-failopen-auto/)
#   2) stop the self-heal hook: remove the "clipboard-failopen" block from ~/.bashrc
#   3) rm ~/.local/share/code-server/tools/.clipboard-failopen.stamp
#   4) reload the browser tab (Ctrl+Shift+R)
# ---------------------------------------------------------------------------

