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

## Voice Control

Digital Twin ships a private **Voice Control** extension (microphone icon in the
activity bar). Talk to the IDE: *"open a terminal in src and run npm test"*,
*"download this URL into downloads"*, *"show the ci folder"*, *"ask Claude to fix
the failing test"*, or dictate text into a terminal or editor.

- **Push-to-talk** by default (tap or `Ctrl+Shift+Space`), or **wake word**
  ("Hey Twin …") chosen during setup. A command ends on a long pause (6 s by
  default), an optional end word such as "over", or another tap.
- **Shows what it heard** and the planned actions; choose *ask every time*,
  *countdown then run*, or *run immediately*. Destructive commands always ask.
- **Phone and tablet**: open the Voice Remote on any device logged in to the IDE.
- **Works with your Claude account**, the same login the `claude` terminal
  command uses, so no API key is needed (an Anthropic API key is the faster,
  pay-per-use alternative).
- **Per-user defaults are chosen right after two-factor setup** on a short
  "Voice Control" page (on/off, push-to-talk or wake word, Claude account or
  API key). The IDE wizard covers existing users and everything is editable
  later. Keys stay on your server. `digitalTwinVoice.enabled: false` or
  `DIGITAL_TWIN_BUNDLED_EXTENSIONS=off` turns it off. Details and a rollout
  checklist: `extensions/voice-control/README.md`.

## Configuration

### Required Variables

| Variable   | Description                        |
|------------|------------------------------------|
| `PASSWORD` | Login password for the web IDE     |

### Optional Variables

| Variable             | Default                        | Description                              |
|----------------------|--------------------------------|------------------------------------------|
| `DIGITAL_TWIN_HOME`  | `/home/digital-twin`           | Volume mount path                        |
| `RUN_AS_USER`        | `digital-twin`                 | Set to `root` if you need root access; any other value means non-root |
| `APP_NAME`           | `Digital Twin`                 | Login page title                         |
| `WELCOME_TEXT`       | `Welcome to Digital Twin`      | Login page message                       |
| `ANTHROPIC_API_KEY`  | –                              | Pre-configures Voice Control (else asked in the UI) |
| `OPENAI_API_KEY`     | –                              | Optional: OpenAI speech-to-text for Voice Control    |
| `DEEPGRAM_API_KEY`   | –                              | Optional: Deepgram speech-to-text for Voice Control  |
| `DIGITAL_TWIN_BUNDLED_EXTENSIONS` | `on`              | `off` ships the server without the Voice Control extension |

### Volume Configuration

> **CRITICAL**: Without a volume, ALL data is lost on every redeploy!

| Setting        | Value                |
|----------------|----------------------|
| **Mount Path** | `/home/digital-twin` |
| **Size**       | 5GB+ recommended     |

### What survives a redeploy, and what does not

Railway rebuilds the container from the image on every deploy. Only the volume
survives, so the entrypoint makes sure the *whole home directory* lives on it:

- The volume is found from `RAILWAY_VOLUME_MOUNT_PATH` (or `DIGITAL_TWIN_HOME`
  if you set it). Legacy mounts such as `/home/clauder` keep working.
- The `digital-twin` user's home in `/etc/passwd` is pointed at the volume on
  every boot, so `su`, `sudo -i`, `gosu` and login shells write to the volume
  too. Before this fix a legacy mount path meant Claude Code's login and
  history, SSH keys and git credentials landed on the ephemeral layer.
- `RUN_AS_USER` other than `root` (including the legacy `clauder`) now runs
  everything as the non-root user. Previously an unrecognised value silently
  stayed root.
- Boot refuses to start on ephemeral storage when a volume is configured but
  not where the home directory is (override with `DIGITAL_TWIN_ALLOW_NO_VOLUME=1`).
  With no volume at all it starts, logs a loud warning and drops a
  `NO-VOLUME-WARNING.md` into the workspace.
- If the volume is mounted at `/home/digital-twin/workspace` only, your projects
  persist but extensions, settings and Claude login do not; mount at
  `/home/digital-twin` instead.

### Upgrading an existing server (do this before you redeploy it)

Servers created before October 2026 with a legacy mount path (`/home/clauder`)
or `RUN_AS_USER=clauder`/`root` have been writing Claude Code's login and
history, SSH keys, git credentials and dotfiles to the container's throwaway
layer. A redeploy deletes that. **On each such server, open a terminal in the
IDE and run this once, then redeploy:**

```bash
curl -fsSL https://raw.githubusercontent.com/mantasdigital/digital-twin/main/scripts/rescue-ephemeral-home.sh | bash
```

It makes a full raw copy of the ephemeral home on the volume, merges it into
the volume home (newer file wins, histories appended, nothing deleted) and is
safe to run repeatedly. Servers created from the current template with the
volume at `/home/digital-twin` need nothing. After the redeploy the entrypoint
keeps every shell's home on the volume, so this is a one-time step.

Things a volume does **not** protect against: deleting the service or the
volume, changing the mount path without moving data, and PR/preview
environments (they get a fresh, empty volume). Turn on **Volume → Backups** in
Railway for scheduled snapshots, and keep your projects pushed to git.

---

## Built With

- [code-server](https://github.com/coder/code-server) – VS Code in the browser
- [Claude Code CLI](https://claude.ai/code) – AI coding assistant by Anthropic

---

## License

MIT – mantasdigital
