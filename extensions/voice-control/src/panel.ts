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

  /** Make sure the view exists and has booted, then deliver a message. */
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
 * The same UI served on a local port. code-server's /proxy/<port>/ route puts
 * it behind the normal login, and vscode.env.asExternalUri gives the public URL.
 * Useful when the embedded webview cannot access the microphone, and for
 * controlling the IDE from a phone.
 */
export class RemoteServer implements Transport {
  private server: http.Server | undefined
  private wss: WebSocketServer | undefined
  private port = 0

  constructor(
    private readonly extensionPath: string,
    private readonly onMessage: Handler,
  ) {}

  get running(): boolean {
    return Boolean(this.server)
  }

  async start(preferredPort: number): Promise<number> {
    if (this.server) return this.port
    const mediaDir = path.join(this.extensionPath, "media")
    const server = http.createServer((req, res) => {
      const url = (req.url || "/").split("?")[0]
      if (url === "/" || url === "/index.html") {
        const nonce = randomNonce()
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Permissions-Policy": "microphone=(self)",
        })
        res.end(
          renderHtml({
            mode: "remote",
            nonce,
            jsHref: "panel.js",
            cssHref: "panel.css",
            csp: `default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self' ws: wss:; img-src 'self' data:; media-src blob: mediastream:;`,
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
    const wss = new WebSocketServer({ server, path: "/ws" })
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

  send(msg: Record<string, unknown>): void {
    if (!this.wss) return
    const data = JSON.stringify(msg)
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data)
    }
  }

  async externalUrl(): Promise<string> {
    const local = vscode.Uri.parse(`http://127.0.0.1:${this.port}/`)
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
}

export function renderHtml(o: HtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="en" data-mode="${o.mode}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${o.csp}">
<title>Voice Control</title>
<link rel="stylesheet" href="${o.cssHref}">
</head>
<body>
<div id="app">
  <header class="top">
    <span class="dot" id="statusDot"></span>
    <span id="statusText">Starting…</span>
    <span class="spacer"></span>
    <button class="icon" id="btnSpeak" title="Read replies aloud">🔊</button>
    <button class="icon" id="btnSettings" title="Settings">⚙</button>
  </header>

  <section id="setup" class="card hidden">
    <h3>Set up voice control</h3>
    <p class="muted">Takes a minute. Keys are stored on your server only.</p>
    <ol class="steps">
      <li id="stepAnthropic"><span class="check"></span>
        <div><b>Anthropic API key</b> <span class="muted">turns what you say into actions</span></div>
        <button data-setup="anthropicKey">Enter key</button></li>
      <li id="stepClaude"><span class="check"></span>
        <div><b>Claude Code login</b> <span class="muted">lets you hand tasks to Claude Code</span></div>
        <button data-setup="claudeLogin">Log in</button></li>
      <li id="stepSpeech"><span class="check"></span>
        <div><b>Speech engine</b> <span class="muted" id="speechDesc"></span></div>
        <button data-setup="provider">Choose</button>
        <button data-setup="speechKey" id="btnSpeechKey">Enter key</button></li>
    </ol>
  </section>

  <section class="mic-area">
    <button id="mic" class="mic" title="Start listening (Ctrl+Shift+Space)">
      <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/><path d="M8 21h8"/></svg>
    </button>
    <div id="hint" class="muted">Tap to talk, tap again to send. Shortcut: Ctrl+Shift+Space</div>
    <div id="micError" class="error hidden"></div>
  </section>

  <section class="card" id="transcriptCard">
    <div class="label">You said</div>
    <div id="transcript" class="transcript muted">…</div>
  </section>

  <section class="card hidden" id="actionsCard">
    <div class="label">Actions</div>
    <ul id="actions"></ul>
    <div id="confirmRow" class="row hidden">
      <button class="primary" id="btnConfirm">Confirm</button>
      <button id="btnCancel">Cancel</button>
      <span class="muted">or say "yes" / "no"</span>
    </div>
    <div id="reply" class="reply hidden"></div>
  </section>

  <section class="card">
    <div class="label">Terminals</div>
    <ul id="terminals" class="terminals"><li class="muted">none</li></ul>
  </section>

  <form id="textForm" class="row">
    <input id="textInput" type="text" placeholder="…or type a command" autocomplete="off">
    <button type="submit">Send</button>
  </form>

  <footer class="muted small">
    <a href="#" id="btnRemote">Open in a browser tab / on your phone</a>
    <span id="modelInfo"></span>
  </footer>
</div>
<script nonce="${o.nonce}" src="${o.jsHref}"></script>
</body>
</html>`
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let s = ""
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}
