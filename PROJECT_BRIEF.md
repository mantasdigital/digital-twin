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
