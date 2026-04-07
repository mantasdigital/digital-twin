# ============================================================================
# Digital Twin - Browser-based VS Code with Claude Code CLI
# https://github.com/mantasdigital/digital-twin
# ============================================================================

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
# CLAUDE CODE CLI INSTALLATION
# Install globally via npm, then replace the Bun binary with a Node wrapper.
# Bun v1.3.11 crashes on Kernel 6.18+ with "Failed to start HTTP Client thread".
# The Node wrapper routes all `claude` calls through Node instead of Bun.
# ============================================================================

RUN npm install -g @anthropic-ai/claude-code \
    && printf '#!/bin/bash\nexec node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js "$@"\n' > /home/digital-twin/.local/bin/claude \
    && chmod +x /home/digital-twin/.local/bin/claude \
    && chown 1000:1000 /home/digital-twin/.local/bin/claude \
    && echo "Claude CLI installed via Node wrapper (Bun crash workaround)"

# ============================================================================
# RUNTIME
# Stay as root - entrypoint handles user switching based on RUN_AS_USER
# ============================================================================

WORKDIR /home/digital-twin/workspace
EXPOSE 8080

# Use our entrypoint which calls code-server directly
ENTRYPOINT ["/usr/bin/railway-entrypoint.sh"]
