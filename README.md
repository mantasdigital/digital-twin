# Digital Twin

**Browser-based VS Code with Claude Code CLI pre-installed**

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/digital-twin?referralCode=mantasdigital)

Deploy a full VS Code development environment in the cloud with Claude Code CLI ready to go. Access it from any browser, on any device. Code with AI assistance anywhere.

---

## Features

- **Claude Code CLI Pre-installed** – Start AI-assisted coding immediately with `claude` or `claude-auto` (YOLO mode)
- **Browser-Based VS Code** – Full IDE experience accessible from any device
- **Persistent Storage** – Your extensions, settings, and projects survive redeploys
- **Non-Root Security** – Runs as the `digital-twin` user with optional sudo access
- **One-Click Deploy** – Deploy to Railway in 60 seconds

---

## Quick Start

### Deploy to Railway

Click the button above, or:

1. Go to [Railway Templates](https://railway.com/templates)
2. Search for "Digital Twin"
3. Click **Deploy** and set your `PASSWORD`
4. Attach a volume to `/home/digital-twin`
5. Open the generated domain in your browser

### First Login

1. Enter the password you set
2. Open the terminal in VS Code
3. Run `claude` to start coding with AI

---

## Configuration

### Required Variables

| Variable   | Description                        |
|------------|------------------------------------|
| `PASSWORD` | Login password for the web IDE     |

### Optional Variables

| Variable             | Default                        | Description                              |
|----------------------|--------------------------------|------------------------------------------|
| `DIGITAL_TWIN_HOME`  | `/home/digital-twin`           | Volume mount path                        |
| `RUN_AS_USER`        | `digital-twin`                 | Set to `root` if you need root access    |
| `APP_NAME`           | `Digital Twin`                 | Login page title                         |
| `WELCOME_TEXT`       | `Welcome to Digital Twin`      | Login page message                       |

### Volume Configuration

> **CRITICAL**: Without a volume, ALL data is lost on every redeploy!

| Setting        | Value                |
|----------------|----------------------|
| **Mount Path** | `/home/digital-twin` |
| **Size**       | 5GB+ recommended     |

---

## Built With

- [code-server](https://github.com/coder/code-server) – VS Code in the browser
- [Claude Code CLI](https://claude.ai/code) – AI coding assistant by Anthropic

---

## License

MIT – mantasdigital
