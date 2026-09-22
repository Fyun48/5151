#!/bin/sh
# 50-clipboard-failopen.sh — code-server container prestart hook (2026-09-22)
#
# WHERE THIS RUNS
#   The official image entrypoint (/usr/bin/entrypoint.sh in codercom/code-server)
#   executes every executable file in $ENTRYPOINTD
#     find "$ENTRYPOINTD" -type f -executable -print -exec {} \;
#   and only afterwards does:
#     exec dumb-init /usr/bin/code-server "$@"
#   so this runs at container start, BEFORE code-server accepts any connection
#   (see https://github.com/coder/code-server/issues/5177).
#   ENTRYPOINTD is pointed at this persistent directory by docker-compose.yml.
#
# WHY
#   VS Code Web's BrowserClipboardService.readText() turns a denied
#   navigator.clipboard.readText() into a sticky "Retry" toast and returns a
#   Promise that only human interaction can settle -> Cline agent tasks that
#   await a clipboard read stall until someone clicks Retry.
#   clipboard-failopen.sh rewrites that one catch block to fail-open.
#   Running it here (instead of from ~/.bashrc) removes the race window:
#   container up == patched, even if nobody ever opens a Terminal.
#
# FAIL-SAFE CONTRACT (must never break code-server startup)
#   * always exits 0
#   * if the VS Code code pattern is not found (future version), the patcher
#     leaves the file untouched and this hook only logs a warning
#   * if the patcher is missing, only logs a warning
#   * log: ~/.local/share/code-server/tools/clipboard-failopen.log
TOOLS="/home/coder/.local/share/code-server/tools"
LOG="$TOOLS/clipboard-failopen.log"

now() { date '+%Y-%m-%d %H:%M:%S'; }
say() { printf '%s %s\n' "$(now)" "$*" >>"$LOG" 2>/dev/null || true; }

say "prestart[entrypointd]: container start (before code-server)"

if [ -x "$TOOLS/clipboard-failopen.sh" ]; then
    "$TOOLS/clipboard-failopen.sh" >>"$LOG" 2>&1
    rc=$?
    if [ "$rc" = "0" ]; then
        say "prestart[entrypointd]: patcher rc=0 -> patched or already patched (reload browser tab to pick it up)"
    else
        say "prestart[entrypointd]: WARNING patcher rc=$rc -> pattern not matched / skipped; FILE LEFT UNTOUCHED, code-server starts normally"
    fi
else
    say "prestart[entrypointd]: WARNING patcher not found at $TOOLS/clipboard-failopen.sh (nothing applied)"
fi

exit 0
