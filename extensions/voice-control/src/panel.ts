import * as crypto from "crypto"
import * as fs from "fs"
import * as http from "http"
import * as path from "path"
import * as vscode from "vscode"
import { WebSocket, WebSocketServer } from "ws"

export type ClientMessage = Record<string, any> & { type: string }
export type Handler = (msg: ClientMessage) => void | Promise<void>

/** Something that can show the panel UI and exchange JSON messages with it. */
export interface Transport {
  send(msg: Record<string, unknown>): void
}

/** The sidebar webview inside VS Code. */
export class PanelViewProvider implements vscode.WebviewViewProvider, Transport {
  private view: vscode.WebviewView | undefined
  private readyWaiters: Array<() => void> = []

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: Handler,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media")
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] }
    const nonce = randomNonce()
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "panel.js"))
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "panel.css"))
    view.webview.html = renderHtml({
      mode: "webview",
      nonce,
      jsHref: js.toString(),
      cssHref: css.toString(),
      csp: `default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${view.webview.cspSource} data:; font-src ${view.webview.cspSource}; media-src blob: mediastream:;`,
    })
    view.webview.onDidReceiveMessage((msg: ClientMessage) => {
      if (msg?.type === "ready") {
        for (const w of this.readyWaiters) w()
        this.readyWaiters = []
      }
      void this.onMessage(msg)
    })
    view.onDidDispose(() => {
      this.view = undefined
    })
  }

  get visible(): boolean {
    return Boolean(this.view?.visible)
  }

  send(msg: Record<string, unknown>): void {
    void this.view?.webview.postMessage(msg)
  }

  /** Make sure the view exists and has booted. */
  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show(false)
      return
    }
    const ready = new Promise<void>((resolve) => this.readyWaiters.push(resolve))
    await vscode.commands.executeCommand("digitalTwinVoice.panel.focus")
    await Promise.race([ready, new Promise((r) => setTimeout(r, 3000))])
  }
}

/**
 * The same UI served on a local port for a separate browser tab, a tablet or a
 * phone. code-server's /proxy/<port>/ route puts it behind the normal login,
 * and vscode.env.asExternalUri gives the public URL.
 *
 * A random token is required on the page and the websocket. Without it any
 * process inside the container could connect to the loopback port and type
 * commands into the user's terminals.
 */
export class RemoteServer implements Transport {
  private server: http.Server | undefined
  private wss: WebSocketServer | undefined
  private port = 0
  private token = ""

  constructor(
    private readonly extensionPath: string,
    private readonly onMessage: Handler,
  ) {}

  get running(): boolean {
    return Boolean(this.server)
  }

  async start(preferredPort: number): Promise<number> {
    if (this.server) return this.port
    this.token = crypto.randomBytes(24).toString("base64url")
    const mediaDir = path.join(this.extensionPath, "media")
    const server = http.createServer((req, res) => {
      const parsed = new URL(req.url || "/", "http://localhost")
      const url = parsed.pathname
      if (url === "/" || url === "/index.html") {
        if (!this.validToken(parsed.searchParams.get("t"))) {
          res.writeHead(403, { "Content-Type": "text/plain" })
          res.end("Voice Remote: open this page from the Voice panel in your IDE (the link carries a one-time token).")
          return
        }
        const nonce = randomNonce()
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Permissions-Policy": "microphone=(self), on-device-speech-recognition=(self)",
        })
        res.end(
          renderHtml({
            mode: "remote",
            nonce,
            token: this.token,
            jsHref: "panel.js",
            cssHref: "panel.css",
            csp: `default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self' ws: wss:; img-src 'self' data:; media-src blob: mediastream:; manifest-src 'self';`,
          }),
        )
        return
      }
      if (url === "/manifest.webmanifest") {
        res.writeHead(200, { "Content-Type": "application/manifest+json", "Cache-Control": "no-store" })
        res.end(
          JSON.stringify({
            name: "Digital Twin Voice",
            short_name: "Twin Voice",
            start_url: `./?t=${this.token}`,
            display: "standalone",
            background_color: "#111318",
            theme_color: "#111318",
            icons: [{ src: "mic.svg", sizes: "any", type: "image/svg+xml" }],
          }),
        )
        return
      }
      const asset =
        url === "/panel.js"
          ? "panel.js"
          : url === "/panel.css"
            ? "panel.css"
            : url === "/mic.svg"
              ? "mic.svg"
              : undefined
      if (asset) {
        const type = asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : "image/svg+xml"
        fs.readFile(path.join(mediaDir, asset), (err, data) => {
          if (err) {
            res.writeHead(404)
            res.end()
            return
          }
          res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" })
          res.end(data)
        })
        return
      }
      res.writeHead(404)
      res.end("not found")
    })
    const wss = new WebSocketServer({ noServer: true })
    server.on("upgrade", (req, socket, head) => {
      const parsed = new URL(req.url || "/", "http://localhost")
      if (parsed.pathname !== "/ws" || !this.validToken(parsed.searchParams.get("t"))) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n")
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
    })
    wss.on("connection", (socket: WebSocket) => {
      socket.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as ClientMessage
          void this.onMessage(msg)
        } catch {
          // ignore malformed frames
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(preferredPort, "127.0.0.1", () => resolve())
    })
    const address = server.address()
    this.port = typeof address === "object" && address ? address.port : preferredPort
    this.server = server
    this.wss = wss
    return this.port
  }

  private validToken(t: string | null): boolean {
    if (!t || !this.token || t.length !== this.token.length) return false
    return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(this.token))
  }

  send(msg: Record<string, unknown>): void {
    if (!this.wss) return
    const data = JSON.stringify(msg)
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data)
    }
  }

  async externalUrl(): Promise<string> {
    const local = vscode.Uri.parse(`http://127.0.0.1:${this.port}/?t=${this.token}`)
    const external = await vscode.env.asExternalUri(local)
    return external.toString(true)
  }

  dispose(): void {
    this.wss?.close()
    this.server?.close()
    this.wss = undefined
    this.server = undefined
  }
}

interface HtmlOptions {
  mode: "webview" | "remote"
  nonce: string
  jsHref: string
  cssHref: string
  csp: string
  token?: string
}

export function renderHtml(o: HtmlOptions): string {
  const remoteHead =
    o.mode === "remote"
      ? `<link rel="manifest" href="manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#111318">
<link rel="apple-touch-icon" href="mic.svg">`
      : ""
  return `<!DOCTYPE html>
<html lang="en" data-mode="${o.mode}"${o.token ? ` data-token="${o.token}"` : ""}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<meta http-equiv="Content-Security-Policy" content="${o.csp}">
<title>Voice Control</title>
${remoteHead}
<link rel="stylesheet" href="${o.cssHref}">
</head>
<body>
<div id="app">
  <header class="top">
    <span class="dot" id="statusDot"></span>
    <span id="statusText">Starting…</span>
    <span class="spacer"></span>
    <button class="small-btn danger hidden" id="btnCancelBusy" title="Cancel the command being processed">Cancel</button>
    <button class="icon" id="btnEar" title="Hands-free: listen for the wake phrase">👂</button>
    <button class="icon" id="btnSpeak" title="Read replies aloud">🔊</button>
    <button class="icon" id="btnSettingsToggle" title="Settings">⚙</button>
  </header>

  <section id="setup" class="card hidden">
    <h3>Set up voice control</h3>
    <p class="muted">Takes a minute. Keys stay on your server.</p>
    <ol class="steps">
      <li id="stepAnthropic"><span class="check"></span>
        <div><b>What understands you</b> <span class="muted" id="brainDesc">Claude account (like the terminal) or an API key</span></div>
        <button data-setup="claudeAccount">Claude account</button>
        <button data-setup="anthropicKey">API key</button></li>
      <li id="stepListening"><span class="check"></span>
        <div><b>Listening</b> <span class="muted" id="listeningDesc"></span></div>
        <button data-setup="listening">Choose</button></li>
      <li id="stepClaude"><span class="check"></span>
        <div><b>Claude Code login</b> <span class="muted">lets you hand tasks to Claude Code</span></div>
        <button data-setup="claudeLogin">Log in</button></li>
      <li id="stepSpeech"><span class="check"></span>
        <div><b>Speech engine</b> <span class="muted" id="speechDesc"></span></div>
        <button data-setup="provider">Choose</button>
        <button data-setup="speechKey" id="btnSpeechKey">Enter key</button></li>
    </ol>
    <p class="muted small" id="setupHint"></p>
  </section>

  <section class="mic-area">
    <button id="mic" class="mic" title="Tap to talk (Ctrl+Shift+Space)">
      <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/><path d="M8 21h8"/></svg>
    </button>
    <div class="level" id="level"><div id="levelBar"></div></div>
    <div id="hint" class="muted">Tap to talk. Stop with a pause, the end word, or another tap.</div>
    <div id="micError" class="error hidden"></div>
  </section>

  <section class="card" id="heardCard">
    <div class="label">Heard</div>
    <div id="heard" class="transcript muted">…</div>
  </section>

  <section class="card hidden" id="actionsCard">
    <div class="label">Planned actions</div>
    <ul id="actions"></ul>
    <div id="countdownRow" class="hidden">
      <div class="bar"><div id="countdownBar"></div></div>
      <div class="row">
        <button class="primary" id="btnRunNow">Run now</button>
        <button id="btnCancelCountdown">Cancel</button>
        <span class="muted small">say "cancel" to stop, "yes" to run now</span>
      </div>
    </div>
    <div id="confirmRow" class="row hidden">
      <button class="primary" id="btnConfirm">Confirm</button>
      <button id="btnCancel">Cancel</button>
      <span class="muted small">or say "yes" / "no"</span>
    </div>
    <div id="reply" class="reply hidden"></div>
  </section>

  <section class="card hidden" id="settingsCard">
    <div class="label">Settings</div>
    <div class="grid">
      <label>Understands you with <select data-setting="brain"><option value="auto">Auto (key if set, else Claude account)</option><option value="claudeAccount">My Claude account (terminal login)</option><option value="apiKey">Anthropic API key</option></select></label>
      <label>Listening <select data-setting="listening.mode"><option value="pushToTalk">Push-to-talk</option><option value="wakeWord">Wake word (hands-free)</option></select></label>
      <label>Wake phrase <input data-setting="listening.wakePhrase" type="text" placeholder="Hey Twin"></label>
      <label>A long pause… <select data-setting="listening.pauseAction"><option value="nothing">is just a pause (end with the execute word or a tap)</option><option value="execute">runs the command</option><option value="cancel">cancels the command</option></select></label>
      <label>Execute word <input data-setting="listening.endWord" type="text" placeholder="execute"></label>
      <label>Cancel word <input data-setting="listening.cancelWord" type="text" placeholder="cancel"></label>
      <label>Terminate word (stops everything) <input data-setting="listening.terminateWord" type="text" placeholder="off"></label>
      <label>Long pause (s) <input data-setting="listening.pauseSeconds" type="number" min="1.5" max="60" step="0.5"></label>
      <label>Confirmation <select data-setting="confirmation.mode"><option value="ask">Ask every time</option><option value="countdown">Show, then run after countdown</option><option value="auto">Run immediately</option></select></label>
      <label>Countdown (s) <input data-setting="confirmation.countdownSeconds" type="number" min="2" max="30" step="1"></label>
      <label>Speech engine <select data-setting="speech.provider"><option value="auto">Auto (built-in server if available)</option><option value="server">Built-in server (Whisper, any browser)</option><option value="browser">Browser (free, Chrome/Edge/Safari)</option><option value="openai">OpenAI</option><option value="deepgram">Deepgram</option></select></label>
      <label>Language <input data-setting="speech.language" type="text" placeholder="auto (e.g. en-US, lt)"></label>
      <label class="check-row"><input data-setting="listening.autoStart" type="checkbox"> Start wake-word listening when the panel opens</label>
      <label class="check-row"><input data-setting="listening.chime" type="checkbox"> Chime on wake / done</label>
      <label class="check-row"><input data-setting="listening.enhanceMic" type="checkbox"> Boost quiet / whispered speech (gain + compression)</label>
      <label class="check-row"><input data-setting="speakReplies" type="checkbox"> Speak replies</label>
    </div>
    <div class="row">
      <button data-setup="speechKey">Speech API key</button>
      <button data-setup="anthropicKey">Anthropic key</button>
      <button data-setup="claudeAccount">Claude login</button>
      <button id="btnAllSettings">All settings…</button>
    </div>
    <p class="muted small">Destructive commands always ask. The wake-word listener uses your browser's speech recognition; on Chrome 139+ it runs on-device when available.</p>
  </section>

  <section class="card">
    <div class="label">Terminals <span class="muted small">(✕ closes)</span></div>
    <ul id="terminals" class="terminals"><li class="muted">none</li></ul>
  </section>

  <section class="card" id="agentsCard">
    <div class="label">Claude agents &amp; voice processes <a href="#" id="btnRefreshProcs" class="small">refresh</a></div>
    <ul id="processes" class="procs"><li class="muted">loading…</li></ul>
    <div id="watchers" class="muted small"></div>
    <div class="row">
      <button class="danger" id="btnStopAll" title="Stop listening everywhere, kill headless voice brains, stop the speech engine and the phone remote">Stop everything</button>
      <span class="muted small">Per row: Stop = graceful, Kill = immediate. Claude Code sessions in terminals are listed too.</span>
    </div>
  </section>

  <form id="textForm" class="row">
    <input id="textInput" type="text" placeholder="…or type a command" autocomplete="off">
    <button type="submit">Send</button>
  </form>

  <footer class="muted small">
    <a href="#" id="btnRemote">Open on phone / tablet / new tab</a>
    <span id="modelInfo"></span>
  </footer>
</div>
<script nonce="${o.nonce}" src="${o.jsHref}"></script>
</body>
</html>`
}

function randomNonce(): string {
  return crypto.randomBytes(16).toString("base64url")
}
