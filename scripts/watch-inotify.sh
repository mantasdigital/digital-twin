#!/usr/bin/env bash
# ============================================================================
# inotify guard (started in the background by railway-entrypoint.sh)
#
# Railway stops a container that uses too many inotify watches. VS Code's
# file watcher takes one watch per directory in the opened folder; big
# workspaces reach hundreds of thousands. Every $INTERVAL seconds this logs
# the total and the top consumers when above WARN, and above KILL it stops
# the VS Code file watcher process (VS Code restarts it and shows "unable to
# watch for file changes"; the IDE keeps working, the container survives).
#
#   DIGITAL_TWIN_WATCH_WARN   default 150000
#   DIGITAL_TWIN_WATCH_KILL   default 400000   (0 = never kill)
#   DIGITAL_TWIN_WATCH_INTERVAL default 30
# ============================================================================
WARN="${DIGITAL_TWIN_WATCH_WARN:-150000}"
KILL="${DIGITAL_TWIN_WATCH_KILL:-400000}"
INTERVAL="${DIGITAL_TWIN_WATCH_INTERVAL:-30}"
limit="$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null || echo 0)"
echo "→ inotify guard: warn at $WARN, protect at $KILL (kernel limit $limit)"
warned=0
while sleep "$INTERVAL"; do
    total=0
    top=""
    for p in /proc/[0-9]*; do
        n=0
        for fd in "$p"/fdinfo/*; do
            [ -r "$fd" ] || continue
            c=$(grep -c '^inotify' "$fd" 2>/dev/null) || c=0
            n=$((n + c))
        done
        [ "$n" -gt 0 ] || continue
        total=$((total + n))
        top="$top
$n $(tr '\0' ' ' <"$p/cmdline" 2>/dev/null | cut -c1-90) [pid ${p#/proc/}]"
    done 2>/dev/null
    if [ "$total" -ge "$WARN" ]; then
        if [ "$warned" = 0 ] || [ "$total" -ge "$KILL" ]; then
            echo "⚠ inotify watches in use: $total (kernel limit $limit). Top consumers:"
            echo "$top" | sort -rn | head -5 | sed 's/^/    /'
            echo "  Fix: exclude large folders in files.watcherExclude, open a project folder instead of the whole workspace, stop dev servers running in watch mode."
            warned=1
        fi
        if [ "$KILL" -gt 0 ] && [ "$total" -ge "$KILL" ]; then
            pid="$(pgrep -f 'bootstrap-fork --type=fileWatcher' | head -1)"
            if [ -n "$pid" ]; then
                echo "✖ Protecting the container: stopping VS Code's file watcher (pid $pid) before Railway stops everything."
                kill "$pid" 2>/dev/null || true
            fi
        fi
    else
        warned=0
    fi
done
