#!/usr/bin/env bash
# ============================================================================
# Digital Twin — "my workspace is empty after a redeploy" diagnostic
#
# Read-only. Run inside the container (IDE terminal) as any user:
#   curl -fsSL https://raw.githubusercontent.com/mantasdigital/digital-twin/main/scripts/diagnose-volume.sh | bash
#
# It reports where the persistent volume is, which folder the IDE opened, and
# where workspace-looking data actually lives, then prints a verdict.
# ============================================================================
set -u
root_dev="$(stat -c %d / 2>/dev/null || echo 0)"
dev_of() { stat -c %d "$1" 2>/dev/null || echo "?"; }
on_volume() { [ -d "$1" ] && [ "$(dev_of "$1")" != "$root_dev" ]; }
count() { ls -A "$1" 2>/dev/null | wc -l | tr -d ' '; }
newest() { find "$1" -xdev -type f -printf '%TY-%Tm-%Td %p\n' 2>/dev/null | sort | tail -1; }
size() { du -sh -x "$1" 2>/dev/null | cut -f1; }
maybe_sudo() { if [ -r "$1" ] && [ -x "$1" ]; then echo ""; elif sudo -n true 2>/dev/null; then echo "sudo -n"; else echo "NOACCESS"; fi; }

echo "===== Digital Twin volume diagnostic ($(date -u +%Y-%m-%dT%H:%MZ)) ====="
echo "user: $(id -un) uid=$(id -u)   HOME=$HOME"
echo "RAILWAY_VOLUME_MOUNT_PATH=${RAILWAY_VOLUME_MOUNT_PATH:-<unset>}  RAILWAY_VOLUME_NAME=${RAILWAY_VOLUME_NAME:-<unset>}"
echo "DIGITAL_TWIN_HOME=${DIGITAL_TWIN_HOME:-<unset>}  CLAUDER_HOME=${CLAUDER_HOME:-<unset>}  RUN_AS_USER=${RUN_AS_USER:-<unset>}"
echo "image commit: ${RAILWAY_GIT_COMMIT_SHA:-<unknown>} ($(printf '%s' "${RAILWAY_GIT_COMMIT_MESSAGE:-}" | head -1))"
echo "passwd home of uid 1000: $(getent passwd 1000 | cut -d: -f6)"
echo
echo "----- mounts (non-virtual) -----"
awk '$3 !~ /proc|sysfs|cgroup|devpts|mqueue|tmpfs|devtmpfs|overlay/ {print "  " $2 "  (" $3 ")"}' /proc/mounts
echo "  /  (overlay, ephemeral)"
echo
echo "----- what the IDE opened -----"
opened="$(tr '\0' '\n' < /proc/1/cmdline 2>/dev/null | tail -1)"
[ -z "$opened" ] && opened="$(ps -eo args | grep -m1 -o '/usr/bin/code-server .*' | awk '{print $NF}')"
echo "  folder: ${opened:-<unknown>}"
if [ -n "$opened" ] && [ -d "$opened" ]; then
    if on_volume "$opened"; then echo "  on persistent volume: YES"; else echo "  on persistent volume: NO  <-- files written here vanish on redeploy"; fi
    echo "  items: $(count "$opened")   size: $(size "$opened")   newest: $(newest "$opened")"
fi
echo
echo "----- candidate homes and workspaces -----"
found_volume_ws=""
seen=""
for h in "${RAILWAY_VOLUME_MOUNT_PATH:-}" "${DIGITAL_TWIN_HOME:-}" "${CLAUDER_HOME:-}" /home/clauder /home/digital-twin /home/coder /root /data /workspace /home/*; do
    [ -n "$h" ] && [ -d "$h" ] || continue
    case " $seen " in *" $h "*) continue ;; esac; seen="$seen $h"
    S="$(maybe_sudo "$h")"
    if [ "$S" = "NOACCESS" ]; then echo "  $h : not readable (no sudo)"; continue; fi
    if on_volume "$h"; then where="VOLUME"; else where="ephemeral"; fi
    echo "  $h  [$where]  items=$($S ls -A "$h" 2>/dev/null | wc -l | tr -d ' ')  size=$($S du -sh -x "$h" 2>/dev/null | cut -f1)"
    for ws in "$h/workspace" "$h/projects" "$h/code"; do
        [ -d "$ws" ] || continue
        n="$($S ls -A "$ws" 2>/dev/null | wc -l | tr -d ' ')"
        echo "      $ws : $n items, $($S du -sh -x "$ws" 2>/dev/null | cut -f1), newest: $($S find "$ws" -xdev -type f -printf '%TY-%Tm-%Td %p\n' 2>/dev/null | sort | tail -1)"
        if [ "$where" = "VOLUME" ] && [ "$n" -gt 1 ] && [ "$ws" != "$opened" ]; then found_volume_ws="$found_volume_ws $ws"; fi
    done
    for d in .claude .ssh .gitconfig .git-credentials; do
        [ -e "$h/$d" ] && echo "      has $d$( [ "$where" = ephemeral ] && echo '  <-- on ephemeral layer, lost on redeploy')"
    done
done
echo
echo "----- verdict -----"
if [ -n "$found_volume_ws" ]; then
    echo "  Your files are still on the volume but the IDE opened a different folder:"
    for ws in $found_volume_ws; do echo "    $ws"; done
    echo "  Fix: in Railway set DIGITAL_TWIN_HOME to the parent of that folder (or remove the variable so it is"
    echo "  auto-detected), redeploy. With the current image this is corrected automatically on boot."
elif [ -n "$opened" ] && on_volume "$opened"; then
    echo "  The opened folder is on the volume. If files are missing they were written outside it"
    echo "  (for example under ~ of root or /home/digital-twin before the fix) or the volume was replaced."
    echo "  Check Railway → service → Volumes: was the volume detached, re-created or its mount path changed?"
else
    echo "  The IDE is working on ephemeral storage. Attach/mount the volume and redeploy; check Railway → Volumes."
fi
