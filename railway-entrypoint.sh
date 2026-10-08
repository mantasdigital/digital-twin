#!/bin/bash
set -e

# ============================================================================
# Digital Twin - Railway Entrypoint
# Handles permission fix and optional user switching
# ============================================================================

echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║              Digital Twin - Claude Code & Node.js Ready              ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo ""

# ============================================================================
# CONFIGURABLE PATHS AND USER
# ============================================================================

# Auto-detect the home volume when $DIGITAL_TWIN_HOME is not set explicitly.
# 1. Railway tells us where the volume is mounted (RAILWAY_VOLUME_MOUNT_PATH).
# 2. Volumes from older deployments may be mounted at /home/clauder (the legacy
#    name) or any other /home/<name>; those keep working as-is.
# 3. Only when no volume is found do we fall back to /home/digital-twin, which
#    lives in the image layer and is wiped on every redeploy.
# Services created from the original template still carry CLAUDER_HOME.
if [ -z "${DIGITAL_TWIN_HOME:-}" ] && [ -n "${CLAUDER_HOME:-}" ] && [ -d "$CLAUDER_HOME" ]; then
    DIGITAL_TWIN_HOME="$CLAUDER_HOME"
    echo "→ Using legacy CLAUDER_HOME=$CLAUDER_HOME"
fi
if [ -z "${DIGITAL_TWIN_HOME:-}" ] && [ -n "${RAILWAY_VOLUME_MOUNT_PATH:-}" ] && [ -d "$RAILWAY_VOLUME_MOUNT_PATH" ]; then
    case "$RAILWAY_VOLUME_MOUNT_PATH" in
        */workspace)
            # Volume holds only the workspace: projects persist, but the home
            # directory (extensions, settings, Claude login) does not.
            DIGITAL_TWIN_HOME="$(dirname "$RAILWAY_VOLUME_MOUNT_PATH")"
            echo "⚠ Volume is mounted at $RAILWAY_VOLUME_MOUNT_PATH (workspace only)."
            echo "  Mount it at $DIGITAL_TWIN_HOME instead so extensions, settings and Claude login persist too."
            ;;
        *)
            DIGITAL_TWIN_HOME="$RAILWAY_VOLUME_MOUNT_PATH"
            ;;
    esac
fi
if [ -z "${DIGITAL_TWIN_HOME:-}" ]; then
    if [ -d /home/digital-twin/workspace ] && [ -n "$(ls -A /home/digital-twin/workspace 2>/dev/null)" ]; then
        # An initialized digital-twin volume (the baked image dir is empty).
        DIGITAL_TWIN_HOME="/home/digital-twin"
    elif [ -d /home/clauder ]; then
        DIGITAL_TWIN_HOME="/home/clauder"
    else
        for dir in /home/*/; do
            name="$(basename "$dir")"
            [ "$name" = "digital-twin" ] && continue
            if [ -d "$dir/workspace" ]; then
                DIGITAL_TWIN_HOME="/home/$name"
                break
            fi
        done
    fi
fi

DIGITAL_TWIN_HOME="${DIGITAL_TWIN_HOME:-/home/digital-twin}"
export DIGITAL_TWIN_HOME
echo "→ Home volume: $DIGITAL_TWIN_HOME"

# ============================================================================
# VOLUME SANITY CHECK
# Everything under $DIGITAL_TWIN_HOME must live on the persistent volume. The
# container's root filesystem is an overlay that is thrown away on redeploy,
# so compare device ids: the same device as "/" means there is no volume.
# ============================================================================

root_dev="$(stat -c %d / 2>/dev/null || echo 0)"
home_dev="$(stat -c %d "$DIGITAL_TWIN_HOME" 2>/dev/null || echo "$root_dev")"
ws_dev="$(stat -c %d "$DIGITAL_TWIN_HOME/workspace" 2>/dev/null || echo "$home_dev")"
NO_VOLUME=0
if [ "$home_dev" != "$root_dev" ]; then
    echo "→ Persistent volume: OK"
elif [ "$ws_dev" != "$root_dev" ]; then
    echo "⚠ Only $DIGITAL_TWIN_HOME/workspace is persistent; the rest of the home directory is not."
else
    # $DIGITAL_TWIN_HOME is on the throwaway layer. Before giving up, look for
    # a persistent directory that holds a home: a wrong or stale variable
    # (e.g. DIGITAL_TWIN_HOME=/home/digital-twin while the volume is still
    # mounted at the legacy /home/clauder) must never hide the user's files
    # behind an empty folder.
    corrected=""
    for cand in "${RAILWAY_VOLUME_MOUNT_PATH:-}" "${CLAUDER_HOME:-}" /home/clauder /home/digital-twin /home/*/ /data; do
        cand="${cand%/}"
        [ -n "$cand" ] && [ -d "$cand" ] || continue
        [ "$(stat -c %d "$cand" 2>/dev/null)" != "$root_dev" ] || continue
        case "$cand" in */workspace) cand="$(dirname "$cand")" ;; esac
        corrected="$cand"
        break
    done
    if [ -n "$corrected" ]; then
        echo "⚠ DIGITAL_TWIN_HOME=$DIGITAL_TWIN_HOME is NOT on the persistent volume; using $corrected instead."
        echo "  Fix the Railway variable (or remove it) to silence this warning."
        DIGITAL_TWIN_HOME="$corrected"
        export DIGITAL_TWIN_HOME
        echo "→ Persistent volume: OK (auto-corrected)"
    elif [ -n "${RAILWAY_VOLUME_MOUNT_PATH:-}" ] && [ "${DIGITAL_TWIN_ALLOW_NO_VOLUME:-}" != "1" ]; then
        echo "✖ A Railway volume is configured at $RAILWAY_VOLUME_MOUNT_PATH but nothing persistent is mounted."
        echo "  Refusing to start on ephemeral storage: files written now would be lost on the next deploy."
        echo "  Check the volume in Railway, or set DIGITAL_TWIN_ALLOW_NO_VOLUME=1 to override."
        exit 1
    else
        echo "⚠⚠⚠ NO PERSISTENT VOLUME at $DIGITAL_TWIN_HOME — ALL FILES WILL BE LOST ON REDEPLOY ⚠⚠⚠"
        echo "    Attach a Railway volume with mount path $DIGITAL_TWIN_HOME."
        NO_VOLUME=1
    fi
fi
DIGITAL_TWIN_UID="${DIGITAL_TWIN_UID:-1000}"
DIGITAL_TWIN_GID="${DIGITAL_TWIN_GID:-1000}"

# RUN_AS_USER: "root" keeps everything as root. Any other value (default
# "digital-twin"; the legacy "clauder" is accepted too) runs code-server and
# every terminal as the unprivileged UID $DIGITAL_TWIN_UID with passwordless
# sudo. Previously an unrecognised value silently stayed root.
RUN_AS_USER="${RUN_AS_USER:-digital-twin}"
if [ "$RUN_AS_USER" != "root" ] && [ "$RUN_AS_USER" != "digital-twin" ]; then
    echo "→ RUN_AS_USER=$RUN_AS_USER is treated as the non-root user digital-twin"
    RUN_AS_USER="digital-twin"
fi

export HOME="$DIGITAL_TWIN_HOME"
export XDG_DATA_HOME="$DIGITAL_TWIN_HOME/.local/share"
export XDG_CONFIG_HOME="$DIGITAL_TWIN_HOME/.config"
export XDG_CACHE_HOME="$DIGITAL_TWIN_HOME/.cache"
export XDG_STATE_HOME="$DIGITAL_TWIN_HOME/.local/state"

# PATH: Include all possible locations for installed tools
# - ~/.local/bin: pip user installs, pipx, local scripts
# - ~/.npm-global/bin: npm global installs (non-root)
# - /usr/local/bin: system-wide installs
# - /usr/lib/node_modules/.bin: npm global installs (root/sudo)
export PATH="$DIGITAL_TWIN_HOME/.local/bin:$DIGITAL_TWIN_HOME/.npm-global/bin:$DIGITAL_TWIN_HOME/.local/node/bin:$DIGITAL_TWIN_HOME/.claude/local:$DIGITAL_TWIN_HOME/node_modules/.bin:/usr/local/bin:/usr/bin:/usr/lib/node_modules/.bin:/usr/lib/code-server/lib/vscode/bin/remote-cli:$PATH"

echo "→ Initial user: $(whoami) (UID: $(id -u))"
echo "→ RUN_AS_USER: $RUN_AS_USER"
echo "→ HOME: $HOME"

# ============================================================================
# DIRECTORY CREATION AND PERMISSION FIX
# ============================================================================

if [ "$(id -u)" = "0" ]; then
    echo ""
    echo "→ Running setup as root..."

    # Create directories if they don't exist
    mkdir -p "$XDG_DATA_HOME" \
             "$XDG_CONFIG_HOME" \
             "$XDG_CACHE_HOME" \
             "$XDG_STATE_HOME" \
             "$HOME/.local/bin" \
             "$HOME/.local/node" \
             "$HOME/.claude" \
             "$HOME/entrypoint.d" \
             "$HOME/workspace" \
             "$XDG_DATA_HOME/code-server/extensions" \
             "$XDG_CONFIG_HOME/code-server" 2>/dev/null || true

    # ========================================================================
    # SHELL PROFILE SETUP
    # ========================================================================

    PROFILE_FILE="$HOME/.bashrc"

    if [ ! -f "$PROFILE_FILE" ] || ! grep -q '.npm-global' "$PROFILE_FILE" 2>/dev/null; then
        echo "→ Setting up shell profile..."
        cat >> "$PROFILE_FILE" << 'PROFILE'

# ============================================================================
# Digital Twin - PATH Configuration
# ============================================================================
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.local/node/bin:$HOME/.claude/local:$PATH"

# npm global prefix for non-root installs
export NPM_CONFIG_PREFIX="$HOME/.npm-global"

# Claude Code alias with --dangerously-skip-permissions
alias claude-auto='claude --dangerously-skip-permissions'
PROFILE

        # Create npm global directory
        mkdir -p "$HOME/.npm-global/bin" 2>/dev/null || true

        echo "  ✓ Shell profile configured"
    fi

    # Also set up .profile for login shells
    if [ ! -f "$HOME/.profile" ] || ! grep -q '.local/bin' "$HOME/.profile" 2>/dev/null; then
        cat >> "$HOME/.profile" << 'PROFILE'

# Load .bashrc for interactive shells
if [ -f "$HOME/.bashrc" ]; then
    . "$HOME/.bashrc"
fi
PROFILE
    fi

    # ========================================================================
    # USER SWITCHING (if RUN_AS_USER=digital-twin)
    # ========================================================================

    # ========================================================================
    # HOME MUST MATCH THE VOLUME
    # gosu, su, sudo -i and login shells take HOME from /etc/passwd. If that
    # still says /home/digital-twin while the volume is mounted elsewhere
    # (e.g. a legacy /home/clauder mount), everything those shells write —
    # Claude Code login and history, SSH keys, git credentials, dotfiles —
    # silently lands on the ephemeral image layer and vanishes on redeploy.
    # ========================================================================

    user_name="$(getent passwd "$DIGITAL_TWIN_UID" | cut -d: -f1)"
    passwd_home="$(getent passwd "$DIGITAL_TWIN_UID" | cut -d: -f6)"
    if [ -n "$user_name" ] && [ "$passwd_home" != "$DIGITAL_TWIN_HOME" ]; then
        if usermod -d "$DIGITAL_TWIN_HOME" "$user_name" 2>/dev/null \
            || sed -i "s#^\($user_name:[^:]*:[^:]*:[^:]*:[^:]*:\)[^:]*:#\1$DIGITAL_TWIN_HOME:#" /etc/passwd; then
            echo "→ Home of user $user_name set to $DIGITAL_TWIN_HOME (was $passwd_home)"
        else
            echo "  ⚠ Could not update the home of $user_name in /etc/passwd"
        fi
    fi

    if [ "$RUN_AS_USER" = "digital-twin" ]; then
        echo "→ Fixing ownership for UID $DIGITAL_TWIN_UID..."
        # Top level synchronously (cheap), then a deep pass in the background:
        # a volume with a million files would otherwise hold up startup past
        # the health-check window. Files created while running as root in an
        # earlier deployment become writable again once the pass finishes.
        chown "$DIGITAL_TWIN_UID:$DIGITAL_TWIN_GID" "$DIGITAL_TWIN_HOME" "$DIGITAL_TWIN_HOME"/.??* "$DIGITAL_TWIN_HOME"/* 2>/dev/null || true
        ( chown -R "$DIGITAL_TWIN_UID:$DIGITAL_TWIN_GID" "$DIGITAL_TWIN_HOME" 2>/dev/null || true
          echo "  ✓ Deep ownership pass complete" ) &
        echo "  ✓ Ownership fixed (deep pass continues in background)"

        # Check if gosu is available
        if command -v gosu &>/dev/null; then
            echo "→ Switching to digital-twin user via gosu..."
            exec gosu "$DIGITAL_TWIN_UID:$DIGITAL_TWIN_GID" "$0" "$@"
        else
            echo "  ⚠ gosu not found, staying as root"
        fi
    else
        echo "→ Staying as root (set RUN_AS_USER=digital-twin to switch)"

        # Create symlinks from /root to volume for persistence
        mkdir -p /root/.local 2>/dev/null || true
        for dir in ".local/share" ".local/bin" ".local/node" ".config" ".cache" ".claude"; do
            target="$DIGITAL_TWIN_HOME/$dir"
            link="/root/$dir"
            if [ -d "$target" ] && [ ! -L "$link" ]; then
                rm -rf "$link" 2>/dev/null || true
                mkdir -p "$(dirname "$link")" 2>/dev/null || true
                ln -sf "$target" "$link" 2>/dev/null || true
            fi
        done
        # Root's own ~/workspace is on the throwaway layer; point it at the volume.
        if [ ! -e /root/workspace ] || [ -L /root/workspace ]; then
            ln -sfn "$DIGITAL_TWIN_HOME/workspace" /root/workspace 2>/dev/null || true
        elif [ -n "$(ls -A /root/workspace 2>/dev/null)" ]; then
            echo "  ⚠ /root/workspace holds files on the ephemeral layer; move them to $DIGITAL_TWIN_HOME/workspace"
        fi
        echo "  ✓ Root directories symlinked to $DIGITAL_TWIN_HOME"
    fi
fi

# ============================================================================
# RUNNING AS FINAL USER
# ============================================================================

echo ""
echo "→ Running as: $(whoami) (UID: $(id -u))"

# ============================================================================
# FIRST RUN SETUP
# ============================================================================

FIRST_RUN_MARKER="$XDG_DATA_HOME/.digital-twin-initialized"

if [ ! -f "$FIRST_RUN_MARKER" ]; then
    echo "→ First run detected - initializing..."

    if [ ! -f "$HOME/workspace/README.md" ]; then
        cat > "$HOME/workspace/README.md" << 'WELCOME'
# Welcome to Digital Twin

Your cloud development environment is ready!

## Features

- **Claude Code CLI** - Pre-installed and ready to use
- **Node.js 22** - Pre-installed and ready to use
- **Persistent Extensions** - Install once, keep forever
- **Full Terminal** - npm, git, and more

## Quick Start

```bash
# Start Claude Code (with auto-accept for automation)
claude --dangerously-skip-permissions

# Or use the alias
claude-auto

# Interactive mode
claude
```

You'll need to authenticate with your Anthropic API key on first use.

## Configuration

Set these environment variables in Railway:

- `RUN_AS_USER=digital-twin` - Run as non-root user (default, recommended for Claude)
- `RUN_AS_USER=root` - Stay as root
- Attach a Railway volume at `/home/digital-twin` or your files are lost on redeploy

Happy coding! 🚀
WELCOME
    fi

    touch "$FIRST_RUN_MARKER" 2>/dev/null || true
    echo "  ✓ Initialization complete"
fi

# A visible warning inside the workspace when nothing persists; removed again
# as soon as a volume is attached.
NO_VOLUME_FILE="$HOME/workspace/NO-VOLUME-WARNING.md"
if [ "$NO_VOLUME" = "1" ]; then
    cat > "$NO_VOLUME_FILE" << 'WARN'
# ⚠ No persistent volume attached

This Digital Twin is running on ephemeral storage. **Everything in this
workspace, your extensions, settings and Claude Code login will be deleted on
the next deploy or restart.**

Fix it in Railway: open the service → **Volumes** → attach a volume with mount
path `/home/digital-twin` (5 GB or more), then redeploy. This file disappears
once a volume is detected.
WARN
elif [ -f "$NO_VOLUME_FILE" ]; then
    rm -f "$NO_VOLUME_FILE" 2>/dev/null || true
fi

# If some OTHER persistent folder looks like a workspace with content, say so
# loudly and leave a note: that is what an "empty workspace after redeploy"
# almost always is — the IDE opened a different folder, the files are safe.
OTHER_WS=""
for cand in "${RAILWAY_VOLUME_MOUNT_PATH:-}/workspace" "${CLAUDER_HOME:-}/workspace" /home/*/workspace /data/workspace; do
    [ -d "$cand" ] || continue
    [ "$(readlink -f "$cand")" = "$(readlink -f "$HOME/workspace")" ] && continue
    [ "$(stat -c %d "$cand" 2>/dev/null)" = "$root_dev" ] && continue
    [ "$(ls -A "$cand" 2>/dev/null | grep -v -c '^README.md$')" -gt 0 ] || continue
    case " $OTHER_WS " in *" $cand "*) continue ;; esac
    OTHER_WS="$OTHER_WS $cand"
done
HINT_FILE="$HOME/workspace/WHERE-ARE-MY-FILES.md"
if [ -n "$OTHER_WS" ]; then
    echo "⚠ Other workspaces with files exist on persistent storage but are not the one opened by the IDE:"
    for w in $OTHER_WS; do echo "    $w"; done
    {
        echo "# Looking for your files?"
        echo
        echo "The IDE opened \`$HOME/workspace\`, but these folders on persistent storage also contain a workspace:"
        echo
        for w in $OTHER_WS; do echo "- \`$w\`"; done
        echo
        echo "Nothing was deleted. To open one of them permanently, set the Railway variable"
        echo "\`DIGITAL_TWIN_HOME\` to its parent folder (or remove the variable) and redeploy."
        echo "This note disappears once no other workspace is found."
    } > "$HINT_FILE" 2>/dev/null || true
elif [ -f "$HINT_FILE" ]; then
    rm -f "$HINT_FILE" 2>/dev/null || true
fi

# ============================================================================
# CLAUDE WRAPPER SELF-HEAL
# Volumes can carry a wrapper from an older image that hardcodes a cli.js
# path that no longer exists (npm prefixes and the claude-code package layout
# both changed over time).  Rewrite any of our shell wrappers with the
# current location-agnostic version.  A user-installed native binary at this
# path is left untouched (it has no shebang), and nothing is created when no
# wrapper exists — /usr/bin/claude from the image install covers that.
# ============================================================================

CLAUDE_WRAPPER="$HOME/.local/bin/claude"
if [ -f "$CLAUDE_WRAPPER" ] && [ "$(head -c 2 "$CLAUDE_WRAPPER" 2>/dev/null)" = "#!" ] &&
    grep -q "@anthropic-ai/claude-code" "$CLAUDE_WRAPPER" 2>/dev/null; then
    cat > "$CLAUDE_WRAPPER" << 'WRAPPER'
#!/bin/bash
# digital-twin claude wrapper (rewritten on boot by railway-entrypoint.sh)
for base in "$HOME/.npm-global/lib/node_modules" /usr/lib/node_modules /usr/local/lib/node_modules; do
  pkg="$base/@anthropic-ai/claude-code"
  if [ -x "$pkg/bin/claude.exe" ]; then exec "$pkg/bin/claude.exe" "$@"; fi
  if [ -f "$pkg/cli-wrapper.cjs" ]; then exec node "$pkg/cli-wrapper.cjs" "$@"; fi
  if [ -f "$pkg/cli.js" ]; then exec node "$pkg/cli.js" "$@"; fi
done
echo "Claude Code not found. Install with: sudo npm install -g @anthropic-ai/claude-code" >&2
exit 1
WRAPPER
    chmod +x "$CLAUDE_WRAPPER"
    echo "→ Refreshed stale claude wrapper at $CLAUDE_WRAPPER"
fi

# ============================================================================
# ENVIRONMENT VERIFICATION
# ============================================================================

echo ""
echo "Environment:"

# Node.js - show source
if [ -x "$DIGITAL_TWIN_HOME/.local/node/bin/node" ]; then
    echo "  → Node.js: $(node --version 2>/dev/null) [volume]"
else
    echo "  → Node.js: $(node --version 2>/dev/null || echo 'not found') [image]"
fi

# npm
echo "  → npm: $(npm --version 2>/dev/null || echo 'not found')"

# git
echo "  → git: $(git --version 2>/dev/null | cut -d' ' -f3 || echo 'not found')"

# Claude Code - show source
if [ -x "$DIGITAL_TWIN_HOME/.local/bin/claude" ]; then
    echo "  → claude: $(claude --version 2>/dev/null || echo 'installed') [volume ~/.local/bin]"
elif [ -x "$DIGITAL_TWIN_HOME/.claude/local/claude" ]; then
    echo "  → claude: $(claude --version 2>/dev/null || echo 'installed') [volume ~/.claude/local]"
elif command -v claude &>/dev/null; then
    echo "  → claude: $(claude --version 2>/dev/null || echo 'installed') [image]"
else
    echo "  → claude: not installed"
fi

# Extensions count
if [ -d "$XDG_DATA_HOME/code-server/extensions" ]; then
    EXT_COUNT=$(find "$XDG_DATA_HOME/code-server/extensions" -maxdepth 1 -type d 2>/dev/null | wc -l)
    EXT_COUNT=$((EXT_COUNT - 1))
    if [ $EXT_COUNT -gt 0 ]; then
        echo "  → Extensions: $EXT_COUNT installed"
    fi
fi

# ============================================================================
# CUSTOM STARTUP SCRIPTS
# ============================================================================

if [ -d "$HOME/entrypoint.d" ]; then
    for script in "$HOME/entrypoint.d"/*.sh; do
        if [ -f "$script" ] && [ -x "$script" ]; then
            echo ""
            echo "Running: $(basename "$script")"
            "$script" || echo "  ⚠ Script exited with code $?"
        fi
    done
fi

# ============================================================================
# BUNDLED EXTENSIONS
# The image ships private extensions (Voice Control) as VSIX files. Install
# each one into the volume's extensions dir once per version so every deploy
# gets them without touching a marketplace. A marker per version keeps boots
# fast; users can still uninstall until the next version bump.
# ============================================================================

BUNDLED_EXT_DIR="/opt/digital-twin/extensions"
MARKER_DIR="$XDG_DATA_HOME/code-server/bundled-extensions"
if [ "${DIGITAL_TWIN_BUNDLED_EXTENSIONS:-on}" = "off" ]; then
    # Opt-out for organisations that do not want Voice Control on their servers.
    # Also removes a copy installed by an earlier boot.
    echo "→ Bundled extensions disabled (DIGITAL_TWIN_BUNDLED_EXTENSIONS=off)"
    for vsix in "$BUNDLED_EXT_DIR"/*.vsix; do
        [ -f "$vsix" ] || continue
        ext_full_id="$(unzip -p "$vsix" extension/package.json 2>/dev/null | jq -r '.publisher + "." + .name' 2>/dev/null)"
        if [ -n "$ext_full_id" ] && [ "$ext_full_id" != "null" ]; then
            code-server --uninstall-extension "$ext_full_id" >/dev/null 2>&1 && echo "  ✓ Removed $ext_full_id" || true
        fi
    done
    rm -rf "$MARKER_DIR" 2>/dev/null || true
elif [ -d "$BUNDLED_EXT_DIR" ]; then
    mkdir -p "$MARKER_DIR" 2>/dev/null || true
    for vsix in "$BUNDLED_EXT_DIR"/*.vsix; do
        [ -f "$vsix" ] || continue
        base="$(basename "$vsix" .vsix)"      # e.g. digital-twin-voice-0.1.0
        ext_id="${base%-*}"                    # e.g. digital-twin-voice
        if [ -f "$MARKER_DIR/$base" ]; then
            continue
        fi
        echo "→ Installing bundled extension: $base"
        if install_output="$(code-server --install-extension "$vsix" --force 2>&1)"; then
            echo "$install_output" | grep -v i18next | sed 's/^/    /'
            rm -f "$MARKER_DIR/$ext_id"-* 2>/dev/null || true
            touch "$MARKER_DIR/$base" 2>/dev/null || true
        else
            echo "$install_output" | grep -v i18next | sed 's/^/    /'
            echo "  ⚠ Failed to install $base (will retry next boot)"
        fi
    done
fi

# ============================================================================
# START CODE-SERVER
# ============================================================================

# Branding customization
APP_NAME="${APP_NAME:-Digital Twin}"
WELCOME_TEXT="${WELCOME_TEXT:-Welcome to Digital Twin}"

echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "Starting $APP_NAME as $(whoami)..."
echo "════════════════════════════════════════════════════════════════════════"
echo ""

exec dumb-init /usr/bin/code-server \
    --bind-addr 0.0.0.0:8080 \
    --app-name "$APP_NAME" \
    --welcome-text "$WELCOME_TEXT" \
    "$DIGITAL_TWIN_HOME/workspace"
