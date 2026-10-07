import Anthropic from "@anthropic-ai/sdk"
import * as vscode from "vscode"
import { describe, execute, isDangerous } from "./actions"
import {
  claudeCodeInstalled,
  claudeCodeLoggedIn,
  Keys,
  SECRET_ANTHROPIC,
  SECRET_DEEPGRAM,
  SECRET_OPENAI,
  settings,
  SpeechProvider,
} from "./config"
import { Action, interpret } from "./intent"
import { ClientMessage, PanelViewProvider, RemoteServer } from "./panel"
import { transcribe } from "./stt"
import { buildContext, snapshotTree, TerminalRegistry, vocabulary } from "./workspace"

const FIRST_RUN_KEY = "digitalTwinVoice.firstRunShown"

class VoiceController {
  private readonly registry = new TerminalRegistry()
  private readonly keys: Keys
  private readonly panel: PanelViewProvider
  private readonly remote: RemoteServer
  private readonly output: vscode.OutputChannel
  private readonly status: vscode.StatusBarItem
  private pending: Action[] | undefined
  private pendingTimer: NodeJS.Timeout | undefined
  private busy = false
  private recording = false

  constructor(private readonly context: vscode.ExtensionContext) {
    this.keys = new Keys(context.secrets)
    this.output = vscode.window.createOutputChannel("Voice Control")
    this.panel = new PanelViewProvider(context.extensionUri, (m) => this.onClientMessage(m))
    this.remote = new RemoteServer(context.extensionPath, (m) => this.onClientMessage(m))
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000)
    this.status.command = "digitalTwinVoice.toggleRecording"
    this.status.tooltip = "Voice Control: start/stop listening (Ctrl+Shift+Space)"
    this.setRecording(false)
    this.status.show()

    context.subscriptions.push(
      this.output,
      this.status,
      vscode.window.registerWebviewViewProvider("digitalTwinVoice.panel", this.panel, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.window.onDidOpenTerminal(() => this.sendState()),
      vscode.window.onDidCloseTerminal(() => this.sendState()),
      vscode.window.onDidChangeActiveTerminal(() => this.sendState()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("digitalTwinVoice")) void this.sendState()
      }),
      { dispose: () => this.remote.dispose() },
    )
  }

  // ---------------------------------------------------------------- transport

  private broadcast(msg: Record<string, unknown>): void {
    this.panel.send(msg)
    this.remote.send(msg)
  }

  private async onClientMessage(msg: ClientMessage): Promise<void> {
    try {
      switch (msg.type) {
        case "ready":
          await this.sendState()
          break
        case "recording":
          this.setRecording(Boolean(msg.active))
          break
        case "transcript":
          await this.handleTranscript(String(msg.text ?? ""))
          break
        case "text":
          await this.handleTranscript(String(msg.text ?? ""))
          break
        case "audio":
          await this.handleAudio(String(msg.data ?? ""), String(msg.mime ?? "audio/webm"))
          break
        case "confirm":
          await this.resolvePending(Boolean(msg.accept))
          break
        case "setup":
          await this.handleSetup(String(msg.action), msg.value)
          break
        case "openRemote":
          await this.openRemote()
          break
        case "openSettings":
          await vscode.commands.executeCommand("workbench.action.openSettings", "digitalTwinVoice")
          break
        case "log":
          this.output.appendLine(`[client] ${msg.text}`)
          break
      }
    } catch (err) {
      this.fail(err)
    }
  }

  async sendState(): Promise<void> {
    const s = settings()
    const anthropic = Boolean(await this.keys.anthropic())
    const speechKey = s.provider === "browser" ? true : Boolean(await this.keys.speech(s.provider))
    this.broadcast({
      type: "state",
      model: s.model,
      provider: s.provider,
      sttMode: s.provider === "browser" ? "browser" : "record",
      language: s.language,
      speakReplies: s.speakReplies,
      setup: {
        anthropic,
        claudeLogin: claudeCodeLoggedIn(),
        claudeInstalled: claudeCodeInstalled(),
        speechKey,
        complete: anthropic && speechKey,
      },
      terminals: this.registry.list(),
      recording: this.recording,
      remoteRunning: this.remote.running,
    })
  }

  private setRecording(active: boolean): void {
    this.recording = active
    this.status.text = active ? "$(record) Listening…" : "$(mic) Voice"
    this.status.backgroundColor = active ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined
  }

  private phase(phase: string, text?: string): void {
    this.broadcast({ type: "status", phase, text })
  }

  private fail(err: unknown): void {
    const message = errorText(err)
    this.output.appendLine(`[error] ${message}`)
    this.broadcast({ type: "error", message })
    this.phase("idle")
  }

  // ---------------------------------------------------------------- commands

  async toggleRecording(): Promise<void> {
    await this.panel.reveal()
    this.panel.send({ type: "record", start: !this.recording })
    this.remote.send({ type: "record", start: !this.recording })
  }

  async typeCommand(): Promise<void> {
    const text = await vscode.window.showInputBox({
      prompt: "What should I do? (same as speaking it)",
      placeHolder: "open a terminal in src and run npm test",
    })
    if (text) {
      await this.panel.reveal()
      await this.handleTranscript(text)
    }
  }

  async openRemote(): Promise<void> {
    const port = await this.remote.start(settings().remotePort)
    const url = await this.remote.externalUrl()
    this.output.appendLine(`Voice Remote listening on 127.0.0.1:${port}, external ${url}`)
    await vscode.env.openExternal(vscode.Uri.parse(url))
    await this.sendState()
  }

  // ---------------------------------------------------------------- setup

  private async handleSetup(action: string, value: unknown): Promise<void> {
    switch (action) {
      case "anthropicKey":
        await this.setAnthropicKey()
        break
      case "speechKey":
        await this.setSpeechKey()
        break
      case "provider":
        await this.chooseProvider()
        break
      case "claudeLogin":
        await this.claudeLogin()
        break
      case "value" /* direct value from the remote page */:
        if (typeof value === "string") await this.keys.set(SECRET_ANTHROPIC, value)
        break
    }
    await this.sendState()
  }

  async setAnthropicKey(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: "Anthropic API key",
      prompt: "Create one at console.anthropic.com → API keys. Stored only on this server.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().startsWith("sk-ant-") ? undefined : "Anthropic keys start with sk-ant-"),
    })
    if (!value) return
    try {
      const client = new Anthropic({ apiKey: value.trim(), maxRetries: 0, timeout: 15_000 })
      await client.models.retrieve(settings().model)
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        vscode.window.showErrorMessage("That API key was rejected by Anthropic. Check it and try again.")
        return
      }
      // Network or other hiccup: store the key anyway and let the first real call report.
      this.output.appendLine(`[setup] key check skipped: ${errorText(err)}`)
    }
    await this.keys.set(SECRET_ANTHROPIC, value)
    vscode.window.showInformationMessage("Voice Control: Anthropic key saved.")
    await this.sendState()
  }

  async chooseProvider(): Promise<void> {
    const picks: Array<vscode.QuickPickItem & { id: SpeechProvider }> = [
      {
        id: "browser",
        label: "Browser speech recognition",
        description: "free, no key, Chrome/Edge/Safari",
        detail: "Fine for short commands. Weakest on technical words.",
      },
      {
        id: "openai",
        label: "OpenAI (gpt-4o-transcribe)",
        description: "high accuracy, needs OpenAI key",
        detail: "Great dictation quality; understands code words.",
      },
      {
        id: "deepgram",
        label: "Deepgram Nova-3",
        description: "high accuracy, fast, needs Deepgram key",
        detail: "Takes vocabulary hints from your workspace.",
      },
    ]
    const pick = await vscode.window.showQuickPick(picks, { title: "Speech engine", ignoreFocusOut: true })
    if (!pick) return
    await vscode.workspace
      .getConfiguration("digitalTwinVoice")
      .update("speech.provider", pick.id, vscode.ConfigurationTarget.Global)
    if (pick.id !== "browser" && !(await this.keys.speech(pick.id))) await this.setSpeechKey(pick.id)
    await this.sendState()
  }

  async setSpeechKey(provider: SpeechProvider = settings().provider): Promise<void> {
    if (provider === "browser") {
      vscode.window.showInformationMessage(
        "The browser speech engine needs no key. Choose OpenAI or Deepgram for higher accuracy.",
      )
      return
    }
    const value = await vscode.window.showInputBox({
      title: provider === "openai" ? "OpenAI API key" : "Deepgram API key",
      prompt: provider === "openai" ? "From platform.openai.com → API keys" : "From console.deepgram.com → API keys",
      password: true,
      ignoreFocusOut: true,
    })
    if (!value) return
    await this.keys.set(provider === "openai" ? SECRET_OPENAI : SECRET_DEEPGRAM, value)
    vscode.window.showInformationMessage(`Voice Control: ${provider} key saved.`)
    await this.sendState()
  }

  async claudeLogin(): Promise<void> {
    if (!claudeCodeInstalled()) {
      vscode.window.showWarningMessage(
        "Claude Code CLI was not found on PATH. Install it with: npm install -g @anthropic-ai/claude-code",
      )
      return
    }
    const { terminal } = this.registry.findOrCreate("Claude")
    terminal.show(false)
    terminal.sendText("claude", true)
    vscode.window.showInformationMessage(
      'Claude Code opened in the "Claude" terminal. Follow its login prompt (or paste an API key). Voice commands like "ask Claude to …" will go there.',
    )
  }

  async clearKeys(): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      "Forget all stored Voice Control API keys?",
      { modal: true },
      "Forget",
    )
    if (ok === "Forget") {
      await this.keys.clearAll()
      await this.sendState()
    }
  }

  async maybeShowFirstRun(): Promise<void> {
    if (this.context.globalState.get<boolean>(FIRST_RUN_KEY)) return
    await this.context.globalState.update(FIRST_RUN_KEY, true)
    if (await this.keys.anthropic()) return
    const choice = await vscode.window.showInformationMessage(
      "Voice Control is installed. Talk to your Digital Twin: open terminals, run commands, hand tasks to Claude Code. Set it up now?",
      "Set up",
      "Later",
    )
    if (choice === "Set up") {
      await this.panel.reveal()
      await this.setAnthropicKey()
    }
  }

  // ---------------------------------------------------------------- pipeline

  private async handleAudio(base64: string, mime: string): Promise<void> {
    const s = settings()
    if (s.provider === "browser") {
      this.broadcast({ type: "error", message: "Speech provider is 'browser'; audio clips are not expected." })
      return
    }
    const apiKey = await this.keys.speech(s.provider)
    if (!apiKey) {
      this.broadcast({ type: "error", message: `No ${s.provider} API key. Add one in the setup card.` })
      return
    }
    const audio = Buffer.from(base64, "base64")
    if (audio.length < 1000) {
      this.phase("idle", "Too short, try again")
      return
    }
    this.phase("transcribing", "Transcribing…")
    const tree = await snapshotTree()
    const text = await transcribe({
      provider: s.provider,
      apiKey,
      audio,
      mime,
      language: s.language,
      vocabulary: vocabulary(this.registry, tree),
      openaiModel: s.openaiModel,
      deepgramModel: s.deepgramModel,
    })
    await this.handleTranscript(text)
  }

  private async handleTranscript(raw: string): Promise<void> {
    const text = raw.trim()
    this.broadcast({ type: "transcript", text })
    if (!text) {
      this.phase("idle", "Didn't hear anything")
      return
    }
    if (this.pending) {
      if (/^(yes|yeah|yep|yup|sure|confirm|confirmed|do it|go ahead|go|ok|okay|proceed)\b/i.test(text)) {
        await this.resolvePending(true)
        return
      }
      if (/^(no|nope|cancel|stop|abort|never ?mind|don'?t)\b/i.test(text)) {
        await this.resolvePending(false)
        return
      }
      await this.resolvePending(false, true)
    }
    if (this.busy) {
      this.broadcast({ type: "error", message: "Still working on the previous request." })
      return
    }
    const apiKey = await this.keys.anthropic()
    if (!apiKey) {
      this.broadcast({ type: "error", message: "Add your Anthropic API key first (setup card above)." })
      return
    }
    this.busy = true
    try {
      this.phase("thinking", "Thinking…")
      const tree = await snapshotTree()
      const s = settings()
      this.output.appendLine(`[you] ${text}`)
      const result = await interpret({
        apiKey,
        model: s.model,
        transcript: text,
        context: buildContext(this.registry, tree),
      })
      this.output.appendLine(`[claude] ${JSON.stringify(result)}`)
      const items = result.actions.map((a) => ({ label: describe(a), dangerous: isDangerous(a) }))
      const needsConfirm = s.confirmDangerous && items.some((i) => i.dangerous)
      this.broadcast({ type: "actions", items, needsConfirm, say: result.say })
      if (needsConfirm) {
        this.pending = result.actions
        this.phase("confirm", "Waiting for confirmation")
        clearTimeout(this.pendingTimer)
        this.pendingTimer = setTimeout(() => void this.resolvePending(false), 45_000)
        return
      }
      await this.runActions(result.actions, tree)
    } finally {
      this.busy = false
    }
  }

  private async resolvePending(accept: boolean, silent = false): Promise<void> {
    const actions = this.pending
    this.pending = undefined
    clearTimeout(this.pendingTimer)
    if (!actions) return
    if (!accept) {
      if (!silent) this.broadcast({ type: "actions", items: [], needsConfirm: false, say: "Cancelled." })
      this.phase("idle")
      return
    }
    await this.runActions(actions, await snapshotTree())
  }

  private async runActions(actions: Action[], tree: string[]): Promise<void> {
    if (!actions.length) {
      this.phase("idle")
      return
    }
    this.phase("executing", "Doing it…")
    const results: string[] = []
    for (const action of actions) {
      try {
        const note = await execute(action, { registry: this.registry, tree })
        results.push(note)
        this.output.appendLine(`[done] ${note}`)
      } catch (err) {
        const note = `${describe(action)} failed: ${errorText(err)}`
        results.push(note)
        this.output.appendLine(`[fail] ${note}`)
      }
    }
    this.broadcast({ type: "results", items: results })
    this.phase("idle", "Done")
    await this.sendState()
  }
}

function errorText(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError)
    return "Anthropic rejected the API key. Set a new one with 'Voice: Set Anthropic API Key'."
  if (err instanceof Anthropic.RateLimitError) return "Anthropic rate limit hit; try again in a moment."
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ""}: ${err.message}`
  if (err instanceof Error) return err.message
  return String(err)
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new VoiceController(context)
  context.subscriptions.push(
    vscode.commands.registerCommand("digitalTwinVoice.toggleRecording", () => controller.toggleRecording()),
    vscode.commands.registerCommand("digitalTwinVoice.openPanel", () =>
      vscode.commands.executeCommand("digitalTwinVoice.panel.focus"),
    ),
    vscode.commands.registerCommand("digitalTwinVoice.openInBrowser", () => controller.openRemote()),
    vscode.commands.registerCommand("digitalTwinVoice.typeCommand", () => controller.typeCommand()),
    vscode.commands.registerCommand("digitalTwinVoice.setAnthropicKey", () => controller.setAnthropicKey()),
    vscode.commands.registerCommand("digitalTwinVoice.setSpeechKey", () => controller.setSpeechKey()),
    vscode.commands.registerCommand("digitalTwinVoice.claudeLogin", () => controller.claudeLogin()),
    vscode.commands.registerCommand("digitalTwinVoice.clearKeys", () => controller.clearKeys()),
  )
  void controller.maybeShowFirstRun()
}

export function deactivate(): void {
  // subscriptions handle cleanup
}
