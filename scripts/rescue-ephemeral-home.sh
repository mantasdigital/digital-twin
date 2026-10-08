#!/usr/bin/env bash
# ============================================================================
# Digital Twin — rescue data written to the ephemeral image layer
#
# Run this INSIDE a running Digital Twin container (open a terminal in the IDE)
# BEFORE redeploying it. Older deployments (volume mounted at a legacy path
# such as /home/clauder, or RUN_AS_USER=clauder/root) wrote Claude Code login
# and history, SSH keys, git credentials and dotfiles to a home directory on
# the container's overlay, which a redeploy throws away. This copies that home
# to the volume (full raw backup) and merges it into the volume home.
#
#   curl -fsSL https://raw.githubusercontent.com/mantasdigital/digital-twin/main/scripts/rescue-ephemeral-home.sh | bash
#
# Safe to run more than once. Never deletes anything on the volume.
# ============================================================================
set -euo pipefail

root_dev="$(stat -c %d /)"
on_volume() { [ -d "$1" ] && [ "$(stat -c %d "$1")" != "$root_dev" ]; }

# Where is the volume?
VOL="${DIGITAL_TWIN_HOME:-${RAILWAY_VOLUME_MOUNT_PATH:-}}"
if [ -z "$VOL" ] || ! on_volume "$VOL"; then
    VOL=""
    for c in /home/clauder /home/digital-twin /home/*; do
        if on_volume "$c"; then VOL="$c"; break; fi
    done
fi
if [ -z "$VOL" ]; then
    echo "✖ No persistent volume found (every /home/* is on the container's root filesystem)."
    echo "  Attach a Railway volume first; there is nowhere to rescue data to."
    exit 1
fi
echo "→ Volume home: $VOL"

# Which homes are ephemeral and hold data?
candidates=()
for h in "$HOME" "$(getent passwd "$(id -u)" | cut -d: -f6)" /home/digital-twin /root; do
    [ -n "$h" ] && [ -d "$h" ] || continue
    [ "$h" = "$VOL" ] && continue
    on_volume "$h" && continue
    case " ${candidates[*]:-} " in *" $h "*) continue ;; esac
    if [ -n "$(ls -A "$h" 2>/dev/null | grep -v -E '^(\.bash_logout|\.bashrc|\.profile|workspace|entrypoint\.d)$')" ]; then
        candidates+=("$h")
    fi
done
if [ ${#candidates[@]} -eq 0 ]; then
    echo "✓ Nothing to rescue: no ephemeral home directory with data."
    exit 0
fi

STAMP="$(date +%Y-%m-%d)"
for EPH in "${candidates[@]}"; do
    echo ""
    echo "→ Ephemeral home with data: $EPH ($(du -sh --exclude=.cache "$EPH" 2>/dev/null | cut -f1))"
    BACKUP="$VOL/.ephemeral-home-backup-$STAMP$(echo "$EPH" | tr / _)"
    echo "→ Full raw backup to $BACKUP"
    mkdir -p "$BACKUP"
    rsync -a --exclude .cache --exclude 'workspace/' --exclude 'entrypoint.d/' "$EPH/" "$BACKUP/"
    echo "→ Merging into $VOL (newer file wins, histories appended, nothing deleted)"
    python3 -I - "$EPH" "$VOL" <<'PY'
import json, os, shutil, subprocess, sys, time
EPH, VOL = sys.argv[1], sys.argv[2]
STAMP = time.strftime("%Y%m%d-%H%M%S")
def log(m): print("  " + m, flush=True)
def concat_unique(src, dst):
    if not os.path.exists(src): return 0
    have = set()
    if os.path.exists(dst):
        with open(dst, "rb") as f: have = set(f.read().splitlines())
    added = 0
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(src, "rb") as f, open(dst, "ab") as out:
        for line in f.read().splitlines():
            if line and line not in have:
                out.write(line + b"\n"); have.add(line); added += 1
    return added
def deep_merge(base, over):
    if isinstance(base, dict) and isinstance(over, dict):
        out = dict(base)
        for k, v in over.items(): out[k] = deep_merge(base[k], v) if k in base else v
        return out
    if isinstance(base, list) and isinstance(over, list):
        out = list(base)
        for v in over:
            if v not in out: out.append(v)
        return out
    return over
def merge_json(rel):
    e, v = os.path.join(EPH, rel), os.path.join(VOL, rel)
    if not os.path.exists(e): return
    os.makedirs(os.path.dirname(v), exist_ok=True)
    if not os.path.exists(v):
        shutil.copy2(e, v); log(f"copied {rel}"); return
    try:
        with open(e) as f: eph = json.load(f)
        with open(v) as f: vol = json.load(f)
    except Exception as ex:
        log(f"! {rel}: could not parse ({ex}); volume copy left untouched"); return
    shutil.copy2(v, f"{v}.pre-merge-{STAMP}")
    with open(v + ".tmp", "w") as f: json.dump(deep_merge(vol, eph), f, indent=2)
    os.replace(v + ".tmp", v); log(f"merged {rel}")
# memory indexes: union of lines, kept newer than the ephemeral copy
ep = os.path.join(EPH, ".claude/projects")
if os.path.isdir(ep):
    for proj in sorted(os.listdir(ep)):
        em = os.path.join(ep, proj, "memory", "MEMORY.md")
        if os.path.exists(em):
            vm = os.path.join(VOL, ".claude/projects", proj, "memory", "MEMORY.md")
            n = concat_unique(em, vm); os.utime(vm, None)
            if n: log(f"{proj}: +{n} memory index lines")
excl = [".cache", "workspace/", "entrypoint.d/", ".bashrc", ".profile", ".bash_logout", ".bash_history",
        ".claude/history.jsonl", ".claude.json", ".claude.json.tmp.*", ".claude/settings.json", "MEMORY.md",
        ".gnupg/", ".npm/_cacache/", ".claude/paste-cache/", ".ephemeral-home-backup-*"]
cmd = ["rsync", "-a", "--update", "--stats"] + [f"--exclude={x}" for x in excl] + [EPH + "/", VOL + "/"]
res = subprocess.run(cmd, capture_output=True, text=True)
if res.returncode != 0: print(res.stderr); sys.exit(1)
for line in res.stdout.splitlines():
    if line.startswith(("Number of regular files transferred", "Total transferred file size")): log(line)
log(f".claude/history.jsonl: +{concat_unique(EPH + '/.claude/history.jsonl', VOL + '/.claude/history.jsonl')} entries")
log(f".bash_history: +{concat_unique(EPH + '/.bash_history', VOL + '/.bash_history')} lines")
merge_json(".claude.json"); merge_json(".claude/settings.json")
if os.path.isdir(os.path.join(EPH, ".gnupg")): log("note: .gnupg not merged (keyrings don't merge safely); it is in the raw backup")
PY
done

uid="$(stat -c %u "$VOL")"
chown -R "$uid" "$VOL/.claude" "$VOL/.claude.json" 2>/dev/null || sudo -n chown -R "$uid" "$VOL/.claude" "$VOL/.claude.json" 2>/dev/null || true
echo ""
echo "✓ Rescue complete. You can redeploy now. Raw backups: $VOL/.ephemeral-home-backup-$STAMP*"
