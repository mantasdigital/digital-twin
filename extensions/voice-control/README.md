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

## What understands you ("brain")

| Option | How | Speed | Cost |
|--------|-----|-------|------|
| **Claude account** | Runs Claude Code headless (`claude -p`, no tools, JSON schema output) with the same login as the terminal | ~3–5 s | included in the subscription |
| **Anthropic API key** | Messages API with strict tools | ~1–2 s | per use |
| **Auto** (default) | API key if one is set, otherwise the Claude account | | |

Setting: `digitalTwinVoice.brain`. The Claude-account path needs `claude`
logged in once (run it in a terminal); the panel notices when the login lands.

## Setup

**Right after two-factor enrollment** the server shows a one-page "Voice
Control" form (on/off, push-to-talk or wake word, Claude account or API key).
It writes `~/.config/code-server/voice-control-seed.json`; the extension
applies it on its next activation, moves any key into SecretStorage and
deletes the file. Also reachable later at `/voice-setup`.

**Existing users** get a 4-step wizard in the side panel (microphone icon),
also available as **Voice: Run Setup Wizard**:

1. **What understands you** – Claude account or Anthropic API key (validated,
   stored in SecretStorage; or set `ANTHROPIC_API_KEY` as a Railway variable).
2. **Listening** – push-to-talk or wake word; wake phrase, optional end word
   and confirmation mode.
3. **Claude Code login** – opens a terminal running `claude` (skipped when the
   account is already the brain).
4. **Speech engine** – `server` (built-in Whisper on this server: free, no key,
   every browser, audio never leaves the server; the default when the image
   has it), `browser` (free, Chrome/Edge/Safari only, audio goes to the browser
   vendor), `openai` (gpt-4o-transcribe) or `deepgram` (Nova-3). All but the
   browser engine get vocabulary hints (terminal and folder names).

## Speech engines

| Engine | Works in | Key | Where audio goes | Notes |
|--------|----------|-----|------------------|-------|
| **server** (default) | every browser, phones | none | stays on your server | faster-whisper, int8, model from `DIGITAL_TWIN_STT_MODEL` (default `base`); 1–3 s per command on a Railway vCPU |
| browser | Chrome, Edge, Safari | none | browser vendor | not available in Perplexity Comet, Brave, Firefox; on-device on Chrome 139+ |
| openai | every browser | OpenAI | OpenAI | best dictation quality |
| deepgram | every browser | Deepgram | Deepgram | fast, vocabulary hints |

**Hands-free (wake word)** works with every engine. With the browser engine
the recognizer listens continuously; with the others the panel keeps the
microphone open, cuts speech into utterances with its voice detector, and the
server checks each one for the wake phrase (and runs the command that followed
it in the same breath). Only the current panel listens; a second device takes
over when its ear button is pressed.

**Quiet and whispered speech.** The microphone goes through the browser's
automatic gain control, then a compressor and an adaptive gain stage before it
reaches the recorder or (Chrome 139+) the recognizer; voice detection adapts
to the room's noise floor; the level meter under the microphone shows what is
heard. The built-in engine additionally normalizes the clip. Turn the
processing off with `listening.enhanceMic` if a studio microphone makes it
pump.

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
4. Smoke-test the intent layer: `node scripts/smoke-intent.mjs --claude "open a
   terminal in src"` (Claude account) or with `ANTHROPIC_API_KEY=…` (API key).
5. **Before redeploying any existing server**, run
   `scripts/rescue-ephemeral-home.sh` inside it (see the root README,
   "Upgrading an existing server"), or its Claude login and history are lost.
6. On the first real deployment, test: push-to-talk in Chrome, wake word, a
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
