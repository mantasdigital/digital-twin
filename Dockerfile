# ============================================================================
# Digital Twin - Browser-based VS Code with Claude Code CLI
# https://github.com/mantasdigital/digital-twin
# ============================================================================

# ============================================================================
# BUILDER STAGE
# Compile this fork's server code (2FA login, signed session cookies,
# branding). The final image overlays it onto the stock code-server install —
# without this, changes under src/ never reach the deployment.
# ============================================================================

FROM node:22-bookworm-slim AS builder

WORKDIR /build

COPY package.json package-lock.json tsconfig.json ./
COPY typings ./typings
# --ignore-scripts: skip the postinstall that pulls test/ and lib/vscode
# submodule deps; plain tsc only needs the type packages.
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY src ./src
RUN npx tsc -p tsconfig.json

# qrcode (used by the 2FA setup page) is not in the stock release's
# node_modules. Stage it with its own deps nested so nothing in the stock
# dependency tree gets clobbered.
RUN mkdir /qr-stage && cd /qr-stage && npm init -y >/dev/null \
    && npm install --no-audit --no-fund --omit=dev qrcode@^1.5.4 \
    && mkdir -p /qr-layout/qrcode/node_modules \
    && cp -r /qr-stage/node_modules/qrcode/. /qr-layout/qrcode/ \
    && for dep in /qr-stage/node_modules/*; do \
         name="$(basename "$dep")"; \
         [ "$name" = "qrcode" ] || [ "$name" = ".package-lock.json" ] || cp -r "$dep" "/qr-layout/qrcode/node_modules/$name"; \
       done

FROM codercom/code-server:4.113.0

USER root

# ============================================================================
# SYSTEM DEPENDENCIES
# Install gosu, Node.js 22, Python/uv, and essential tools
# Cache bust: 2026-04-07-v8
# ============================================================================

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        gosu \
        nodejs \
        python3 \
        python3-pip \
        python3-venv \
        pipx \
        git \
        curl \
        wget \
        unzip \
        jq \
        htop \
        vim \
        nano \
        ripgrep \
    && pip3 install --break-system-packages uv \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ============================================================================
# PERSISTENCE CONFIGURATION
# Default to /home/digital-twin for new deployments
# ============================================================================

ENV HOME=/home/digital-twin
ENV USER=digital-twin

# XDG Base Directory Specification
ENV XDG_DATA_HOME=/home/digital-twin/.local/share
ENV XDG_CONFIG_HOME=/home/digital-twin/.config
ENV XDG_CACHE_HOME=/home/digital-twin/.cache
ENV XDG_STATE_HOME=/home/digital-twin/.local/state

# PATH: Volume paths FIRST (user installs), image paths LAST (fallbacks)
ENV PATH="/home/digital-twin/.local/bin:/home/digital-twin/.local/node/bin:/home/digital-twin/.claude/local:/home/digital-twin/node_modules/.bin:/usr/local/bin:/usr/bin:/usr/lib/code-server/lib/vscode/bin/remote-cli:${PATH}"

# Custom startup scripts directory
ENV ENTRYPOINTD=/home/digital-twin/entrypoint.d

# ============================================================================
# USER SETUP
# Create digital-twin user (UID 1000) with passwordless sudo
# - Stays non-root for Claude YOLO mode compatibility
# - Can use sudo for package installs (apt, npm -g, pip, etc.)
# ============================================================================

RUN apt-get update && apt-get install -y sudo \
    && rm -rf /var/lib/apt/lists/* \
    && (groupadd -g 1000 digital-twin 2>/dev/null || true) \
    && (useradd -m -s /bin/bash -u 1000 -g 1000 digital-twin 2>/dev/null || usermod -l digital-twin -d /home/digital-twin -m coder 2>/dev/null || true) \
    && (groupmod -n digital-twin coder 2>/dev/null || true) \
    && mkdir -p /etc/sudoers.d \
    && echo "digital-twin ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/digital-twin \
    && chmod 0440 /etc/sudoers.d/digital-twin \
    && chown root:root /etc/sudoers.d/digital-twin

# ============================================================================
# DIRECTORY SETUP
# ============================================================================

RUN mkdir -p \
    /home/digital-twin/.local/share \
    /home/digital-twin/.config \
    /home/digital-twin/.cache \
    /home/digital-twin/.local/state \
    /home/digital-twin/.local/bin \
    /home/digital-twin/.local/node \
    /home/digital-twin/.claude \
    /home/digital-twin/entrypoint.d \
    /home/digital-twin/workspace \
    && chown -R 1000:1000 /home/digital-twin

# Copy our custom entrypoint (replaces base image's entrypoint)
COPY railway-entrypoint.sh /usr/bin/railway-entrypoint.sh
RUN chmod +x /usr/bin/railway-entrypoint.sh

# ============================================================================
# FORK SERVER CODE OVERLAY
# Replace the stock server layer with this fork's build (adds mandatory TOTP
# 2FA at login and HMAC-signed session cookies). lib/vscode stays stock.
# ============================================================================

COPY --from=builder /build/out /usr/lib/code-server/out
COPY src/browser /usr/lib/code-server/src/browser
COPY --from=builder /qr-layout/qrcode /usr/lib/code-server/node_modules/qrcode

# ============================================================================
# CLAUDE CODE CLI INSTALLATION
# Install globally via npm and provide a location-agnostic launcher.  The
# wrapper prefers a user-installed copy on the volume, then the image's
# npm-global package, and handles every package layout claude-code has
# shipped (native bin/claude.exe, cli-wrapper.cjs, legacy cli.js).  Never
# hardcode a single path here: volumes outlive images and npm's global
# prefix differs between node distributions (/usr/lib vs /usr/local/lib).
# ============================================================================

RUN npm install -g @anthropic-ai/claude-code \
    && printf '%s\n' \
        '#!/bin/bash' \
        '# digital-twin claude wrapper (rewritten on boot by railway-entrypoint.sh)' \
        'for base in "$HOME/.npm-global/lib/node_modules" /usr/lib/node_modules /usr/local/lib/node_modules; do' \
        '  pkg="$base/@anthropic-ai/claude-code"' \
        '  if [ -x "$pkg/bin/claude.exe" ]; then exec "$pkg/bin/claude.exe" "$@"; fi' \
        '  if [ -f "$pkg/cli-wrapper.cjs" ]; then exec node "$pkg/cli-wrapper.cjs" "$@"; fi' \
        '  if [ -f "$pkg/cli.js" ]; then exec node "$pkg/cli.js" "$@"; fi' \
        'done' \
        'echo "Claude Code not found. Install with: sudo npm install -g @anthropic-ai/claude-code" >&2' \
        'exit 1' \
        > /home/digital-twin/.local/bin/claude \
    && chmod +x /home/digital-twin/.local/bin/claude \
    && chown 1000:1000 /home/digital-twin/.local/bin/claude \
    && echo "Claude CLI installed with location-agnostic launcher"

# ============================================================================
# RUNTIME
# Stay as root - entrypoint handles user switching based on RUN_AS_USER
# ============================================================================

WORKDIR /home/digital-twin/workspace
EXPOSE 8080

# Use our entrypoint which calls code-server directly
ENTRYPOINT ["/usr/bin/railway-entrypoint.sh"]
