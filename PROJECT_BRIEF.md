# Project Brief: Digital Twin - Railway Template

**Project:** Digital Twin - Browser-based VS Code with Claude Code CLI  
**Repository:** `mantasdigital/digital-twin`  
**Status:** Active

---

## Summary

A production-ready Railway template providing browser-based VS Code (code-server) with pre-installed Claude Code CLI, persistent extensions, and configurable user permissions.

---

## Key Features

- Browser-based VS Code via code-server
- Claude Code CLI pre-installed and ready
- Persistent storage for extensions, settings, and projects
- Non-root security with optional sudo access
- One-click Railway deployment
- Voice Control: private bundled VS Code extension (speech → Claude tool use → terminals/explorer/Claude Code)

---

## Configuration Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PASSWORD` | Yes | - | code-server login password |
| `RUN_AS_USER` | No | `digital-twin` | Set to `root` for root execution |
| `DIGITAL_TWIN_HOME` | No | `/home/digital-twin` | Volume mount path |
| `DIGITAL_TWIN_UID` | No | `1000` | User ID for digital-twin |
| `DIGITAL_TWIN_GID` | No | `1000` | Group ID for digital-twin |
| `APP_NAME` | No | `Digital Twin` | Login page branding |
| `WELCOME_TEXT` | No | `Welcome to Digital Twin` | Login page message |
| `ANTHROPIC_API_KEY` | No | - | Pre-configures the Voice Control extension (otherwise asked in the UI) |
| `OPENAI_API_KEY` | No | - | Optional OpenAI speech-to-text for Voice Control |
| `DEEPGRAM_API_KEY` | No | - | Optional Deepgram speech-to-text for Voice Control |
| `DIGITAL_TWIN_BUNDLED_EXTENSIONS` | No | `on` | `off` ships without the Voice Control extension |

---

## Persistence Strategy

### Volume-First PATH Priority
```
$HOME/.local/bin          <- User-installed tools (Claude, etc.)
$HOME/.local/node/bin     <- User-installed Node.js
$HOME/.claude/local       <- Claude Code from volume
/usr/local/bin            <- Image fallback (Claude)
/usr/bin                  <- Image fallback (Node.js)
```

### Boot-time guarantees (railway-entrypoint.sh)
- Volume located via `RAILWAY_VOLUME_MOUNT_PATH` → `DIGITAL_TWIN_HOME` → legacy `/home/<name>` scan
- `/etc/passwd` home of UID 1000 is rewritten to `$DIGITAL_TWIN_HOME` so every shell (gosu/su/sudo/login) writes to the volume
- Any `RUN_AS_USER` other than `root` runs as the non-root user (legacy `clauder` included)
- Device-id check: refuses to boot on ephemeral storage when a volume is configured but not mounted at the home; warns + writes `workspace/NO-VOLUME-WARNING.md` when no volume exists
- Ownership fix: top level synchronously, deep `chown -R` in the background (large volumes must not block the health check)

### What Persists (on volume)
- Extensions: `~/.local/share/code-server/extensions/`
- Claude Code: `~/.local/bin/claude` or `~/.claude/`
- Claude auth: `~/.claude/` (API keys, settings)
- Node.js: `~/.local/node/` (if user installs)
- Shell config: `~/.bashrc`, `~/.profile`
- Workspace: `~/workspace/`

---

## Key Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Image build configuration |
| `railway-entrypoint.sh` | Container startup script |
| `railway.toml` | Railway deployment config |
| `README.md` | User documentation |
| `extensions/voice-control/` | Voice Control extension source (built into a VSIX by the Dockerfile, installed on boot by the entrypoint) |
