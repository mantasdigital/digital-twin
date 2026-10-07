# Digital Twin Voice Control

Private VS Code extension bundled into the Digital Twin image. It is never
published to a marketplace: the Docker build packages it into a VSIX under
`/opt/digital-twin/extensions/` and `railway-entrypoint.sh` installs it into
the volume on boot (once per version). Set `DIGITAL_TWIN_BUNDLED_EXTENSIONS=off`
on a service to ship without it.

## What it does

Talk, and the IDE acts:

- "open a new terminal called server in src slash node"
- "run npm test in terminal two"
- "download https://example.com/data.zip into downloads"
- "show the ci folder in the explorer" / "open package json"
- "ask Claude to add retry logic to the mailer"
- "type: fix login redirect loop" (dictation into the active terminal or editor)

Pipeline: microphone → speech-to-text → Claude (tool use, strict schemas) →
VS Code API (terminals, explorer, editor, commands). What was heard and the
planned actions are always shown before or while they run.

## Listening modes

| Mode | How it starts | Notes |
|------|---------------|-------|
| **Push-to-talk** (default) | Tap the mic, `Ctrl+Shift+Space`, or the status-bar item | Nothing is heard until you start it. |
| **Wake word** | Say the wake phrase (default "Hey Twin"), then the command | Keeps the mic open while the panel is visible. Fuzzy phrase match, aliases for common mishearings, muted while the panel speaks, one active listener across devices. Say "stop listening" to disarm. `Ctrl+Shift+Alt+Space` toggles. |

A command ends when you **pause** (default 6 s, adjustable 1.5–30 s), say the
optional **end word** (e.g. "over"), tap again, or hit the 60 s limit. The
pause always works, with or without an end word.

## Confirmation

| Mode | Behaviour |
|------|-----------|
| **Ask every time** | Shows heard text and actions; nothing runs until "yes" / Confirm. |
| **Countdown** (default) | Shows heard text and actions, runs after 5 s unless you say "cancel" or tap Cancel. "Yes" runs immediately. |
| **Run immediately** | Executes at once. |

Destructive commands (`rm -rf`, `sudo`, force-push, closing windows, …) always
require an explicit yes regardless of the mode.

## Setup (first run)

The side panel (microphone icon in the activity bar) runs a 4-step wizard,
also available as **Voice: Run Setup Wizard**:

1. **Anthropic API key** – required; validated and stored in VS Code
   SecretStorage on the server. Or set `ANTHROPIC_API_KEY` as a Railway variable.
2. **Listening** – push-to-talk or wake word; wake phrase, optional end word
   and confirmation mode.
3. **Claude Code login** – opens a terminal running `claude`.
4. **Speech engine** – `browser` (free, built-in), `openai` (gpt-4o-transcribe)
   or `deepgram` (Nova-3). Paid engines get vocabulary hints (terminal and
   folder names) and are much better on technical words.

Everything is editable afterwards in the panel's ⚙ Settings section (also on
the phone) or in VS Code settings under `digitalTwinVoice.*`.
`digitalTwinVoice.enabled: false` turns the whole feature off; the first-run
prompt also offers "Turn off".

## Phone, tablet, second tab

**Open on phone / tablet / new tab** starts a small server on
`127.0.0.1:39339` and gives you a link through code-server's `/proxy/<port>/`
route. You must be logged in to the IDE on that device. The link carries a
random token (valid until the IDE restarts); without it the page and websocket
return 403, so other processes in the container cannot drive your terminals.
The page is installable to the home screen (Android and iOS). On iPhone/iPad
keep the page open; the screen lock stops the microphone.

## Microphone in the side panel

Stock VS Code does not grant `microphone` to webview iframes. The Dockerfile
patches the two allow-lists in the shipped workbench so the panel can record.
If that ever fails (or a browser still blocks it), the phone/tab remote works
the same way.

## Privacy

- API keys never leave the server; the webview and the remote page only
  receive state, never secrets.
- The **browser** speech engine sends audio to the browser vendor (Google for
  Chrome, Apple for Safari). On Chrome 139+ the wake-word listener asks for
  on-device recognition (`processLocally`) so ambient audio stays local.
- The **wake-word mode** keeps the microphone open while the panel is visible.
  It is off by default, chosen explicitly during setup, and indicated in the
  status bar (`👂 "Hey Twin"`) and by the browser's tab microphone indicator.
- Transcripts and chosen actions are logged to the "Voice Control" output
  channel on the server only.

## Rollout checklist (before pushing to shared servers)

1. Build the image once on Railway (or locally with Docker) and check the build
   log for `Webview content iframe: microphone allowed` and
   `Webview host iframe: microphone allowed`. A WARNING there means the panel
   mic is blocked and users must use the phone/tab remote.
2. Decide per service: `DIGITAL_TWIN_BUNDLED_EXTENSIONS=off` to ship without
   Voice Control; `ANTHROPIC_API_KEY` to pre-configure it.
3. Tell users the feature is opt-in: it does nothing until the wizard runs, and
   wake-word mode is never on by default.
4. Smoke-test the intent layer with your key:
   `ANTHROPIC_API_KEY=… node scripts/smoke-intent.mjs "open a terminal in src"`.
5. On the first real deployment, test: push-to-talk in Chrome, wake word, a
   destructive command (must ask), "stop listening", and the phone remote.

## Development

```bash
cd extensions/voice-control
npm install
npm run check     # tsc
npm run build     # esbuild → dist/extension.js
npm run package   # VSIX
code-server --install-extension digital-twin-voice-*.vsix --force
```

Logs: Output panel → "Voice Control".
