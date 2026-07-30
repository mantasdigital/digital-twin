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
# Volumes from older deployments may be mounted at /home/clauder (the legacy
# name) or any other /home/<name>; those keep working as-is. Only when no
# existing volume is found do we fall back to creating /home/digital-twin.
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
DIGITAL_TWIN_UID="${DIGITAL_TWIN_UID:-1000}"
DIGITAL_TWIN_GID="${DIGITAL_TWIN_GID:-1000}"

# RUN_AS_USER: Defaults to "digital-twin" for non-root. Set to "root" if needed.
RUN_AS_USER="${RUN_AS_USER:-digital-twin}"

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

    if [ "$RUN_AS_USER" = "digital-twin" ]; then
        echo "→ Fixing permissions for digital-twin user (UID: $DIGITAL_TWIN_UID)..."
        chown -R "$DIGITAL_TWIN_UID:$DIGITAL_TWIN_GID" "$DIGITAL_TWIN_HOME" 2>/dev/null || true
        echo "  ✓ Permissions fixed"

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

- `RUN_AS_USER=digital-twin` - Run as non-root user (recommended for Claude)
- `RUN_AS_USER=root` - Stay as root

Happy coding! 🚀
WELCOME
    fi

    touch "$FIRST_RUN_MARKER" 2>/dev/null || true
    echo "  ✓ Initialization complete"
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
