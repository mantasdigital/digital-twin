# Digital Twin Voice Control

Private VS Code extension bundled into the Digital Twin image. It is never
published to a marketplace: the Docker build packages it into a VSIX under
`/opt/digital-twin/extensions/` and `railway-entrypoint.sh` installs it into
the volume on boot (once per version).

## What it does

Talk, and the IDE acts:

- "open a new terminal called server in src slash node"
- "run npm test in terminal two"
- "download https://example.com/data.zip into downloads"
- "show the ci folder in the explorer" / "open package json"
- "ask Claude to add retry logic to the mailer"
- "type: fix login redirect loop" (dictation into the active terminal or editor)

Pipeline: microphone → speech-to-text → Claude (tool use, strict schemas) →
VS Code API (terminals, explorer, editor, commands).

## Setup (first run)

The side panel (microphone icon in the activity bar) shows a setup card:

1. **Anthropic API key** – required. Stored in VS Code SecretStorage on the
   server, or set `ANTHROPIC_API_KEY` as a Railway variable to skip the prompt.
2. **Claude Code login** – opens a terminal running `claude`; follow its login
   prompt. Needed for "ask Claude …" commands.
3. **Speech engine** – `browser` (free, built-in, Chrome/Edge/Safari),
   `openai` (gpt-4o-transcribe, needs `OPENAI_API_KEY` or a stored key) or
   `deepgram` (Nova-3, needs `DEEPGRAM_API_KEY` or a stored key). The paid
   engines get vocabulary hints (terminal names, folder names) and are much
   better on technical words.

Shortcut: `Ctrl+Shift+Space` toggles listening. Destructive commands
(`rm -rf`, `sudo`, force-push, …) ask for a spoken or clicked confirmation.

## Microphone in the side panel

Stock VS Code does not grant `microphone` to webview iframes. The Dockerfile
patches the two allow-lists in the shipped workbench so the panel can record.
If that ever fails (or on a browser that still blocks it), use **Open in a
browser tab** at the bottom of the panel: the same UI is served on a local
port behind code-server's `/proxy/<port>/` route, so it also works from a
phone that is logged in to the IDE.

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
