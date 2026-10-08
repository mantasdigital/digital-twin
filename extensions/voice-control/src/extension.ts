import Anthropic from "@anthropic-ai/sdk"
import * as fs from "fs"
import * as vscode from "vscode"
import { describe, execute, isDangerous } from "./actions"
import {
  claudeCodeInstalled,
  claudeCodeLoggedIn,
  ConcreteProvider,
  findClaudeBinary,
  Keys,
  matchWake,
  SECRET_ANTHROPIC,
  SECRET_DEEPGRAM,
  SECRET_OPENAI,
  seedFileCandidates,
  settings,
  SpeechProvider,
  updateSetting,
  VoiceSeed,
} from "./config"
import { Action, interpret, interpretViaClaudeCode } from "./intent"
import { ClientMessage, PanelViewProvider, RemoteServer } from "./panel"
import { ServerStt, transcribe } from "./stt"
import { buildContext, snapshotTree, TerminalRegistry, vocabulary } from "./workspace"

const FIRST_RUN_KEY = "digitalTwinVoice.firstRunShown"

const YES = /^(yes|yeah|yep|yup|sure|confirm|confirmed|do it|run it|go ahead|go|ok|okay|proceed|run now)\b/i
const NO = /^(no|nope|cancel|stop|abort|never ?mind|don'?t|wait)\b/i
const STOP_LISTENING = /^(stop|pause|disable) (listening|hands ?free)|^go to sleep\b|^sleep now\b/i

interface Pending {
  actions: Action[]
  heard: string
  timer?: NodeJS.Timeout
}

class VoiceController {
  private readonly registry = new TerminalRegistry()
  private readonly keys: Keys
  private readonly panel: PanelViewProvider
  private readonly remote: RemoteServer
  private readonly output: vscode.OutputChannel
  private readonly status: vscode.StatusBarItem
  private readonly serverStt: ServerStt
  private pending: Pending | undefined
  private busy = false
  private recording = false
  private handsFreeOwner: string | undefined

  constructor(private readonly context: vscode.ExtensionContext) {
    this.keys = new Keys(context.secrets)
    this.output = vscode.window.createOutputChannel("Voice Control")
    this.serverStt = new ServerStt(ServerStt.findWorker(context.extensionPath), (line) => this.output.appendLine(line))
    void this.serverStt.probe().then(() => this.sendState())
    this.panel = new PanelViewProvider(context.extensionUri, (m) => this.onClientMessage(m))
    this.remote = new RemoteServer(context.extensionPath, (m) => this.onClientMessage(m))
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000)
    this.status.command = "digitalTwinVoice.toggleRecording"
    this.refreshStatusBar()

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
        if (e.affectsConfiguration("digitalTwinVoice")) {
          this.refreshStatusBar()
          void this.sendState()
        }
      }),
      { dispose: () => this.remote.dispose() },
      { dispose: () => this.serverStt.dispose() },
    )
  }

  /** The speech engine actually in use ("auto" resolved). */
  private resolveProvider(): ConcreteProvider {
    const p = settings().provider
    if (p === "auto") return this.serverStt.available ? "server" : "browser"
    return p
  }

  // ---------------------------------------------------------------- brain

  /** Which engine understands the user right now, or undefined if none is ready. */
  private async resolveBrain(): Promise<"apiKey" | "claudeAccount" | undefined> {
    const s = settings()
    const key = await this.keys.anthropic()
    const account = claudeCodeInstalled() && claudeCodeLoggedIn()
    if (s.brain === "apiKey") return key ? "apiKey" : undefined
    if (s.brain === "claudeAccount") return account ? "claudeAccount" : undefined
    return key ? "apiKey" : account ? "claudeAccount" : undefined
  }

  /** Apply defaults chosen on the server's post-2FA page, once. */
  private async applySeed(): Promise<void> {
    for (const file of seedFileCandidates()) {
      let seed: VoiceSeed
      try {
        seed = JSON.parse(fs.readFileSync(file, "utf8"))
      } catch {
        continue
      }
      try {
        if (typeof seed.enabled === "boolean") {
          await vscode.workspace
            .getConfiguration("digitalTwinVoice")
            .update("enabled", seed.enabled, vscode.ConfigurationTarget.Global)
        }
        if (seed.listeningMode) await updateSetting("listening.mode", seed.listeningMode)
        if (seed.wakePhrase) await updateSetting("listening.wakePhrase", seed.wakePhrase)
        if (seed.brain) await updateSetting("brain", seed.brain)
        if (seed.anthropicApiKey && seed.anthropicApiKey.startsWith("sk-ant-"))
          await this.keys.set(SECRET_ANTHROPIC, seed.anthropicApiKey)
        await this.context.globalState.update("digitalTwinVoice.listeningChosen", true)
        await this.context.globalState.update(FIRST_RUN_KEY, true)
        this.output.appendLine(`[setup] applied defaults from ${file}`)
      } finally {
        try {
          fs.unlinkSync(file) // the key must not linger on disk
        } catch {
          // ignore
        }
      }
      if (seed.brain === "claudeAccount" && settings().enabled && !claudeCodeLoggedIn()) {
        const choice = await vscode.window.showInformationMessage(
          "Voice Control will use your Claude account. Log in once by running `claude` in a terminal.",
          "Log in now",
          "Later",
        )
        if (choice === "Log in now") await this.claudeLogin()
      }
      return
    }
  }

  private loginPoll: NodeJS.Timeout | undefined
  /** After "Log in" was opened in a terminal, notice when the credentials appear. */
  private watchForLogin(): void {
    clearInterval(this.loginPoll)
    const started = Date.now()
    this.loginPoll = setInterval(() => {
      if (claudeCodeLoggedIn()) {
        clearInterval(this.loginPoll)
        void this.sendState()
        vscode.window.showInformationMessage("Claude Code is logged in. Voice Control can use your Claude account now.")
      } else if (Date.now() - started > 10 * 60_000) clearInterval(this.loginPoll)
    }, 3000)
  }

  // ---------------------------------------------------------------- transport

  private broadcast(msg: Record<string, unknown>): void {
    this.panel.send(msg)
    this.remote.send(msg)
  }

  private async onClientMessage(msg: ClientMessage): Promise<void> {
    if (!settings().enabled && msg.type !== "ready" && msg.type !== "openSettings") return
    try {
      switch (msg.type) {
        case "ready":
          this.output.appendLine(`[client] ${msg.kind || "panel"} connected: ${String(msg.ua || "").slice(0, 160)}`)
          await this.sendState()
          break
        case "recording":
          this.recording = Boolean(msg.active)
          this.refreshStatusBar()
          break
        case "handsFree":
          if (msg.active) this.handsFreeOwner = String(msg.clientId || "panel")
          else if (!msg.clientId || msg.clientId === this.handsFreeOwner) this.handsFreeOwner = undefined
          this.refreshStatusBar()
          await this.sendState()
          break
        case "transcript":
        case "text":
          await this.handleTranscript(String(msg.text ?? ""))
          break
        case "audio":
          await this.handleAudio(
            String(msg.data ?? ""),
            String(msg.mime ?? "audio/webm"),
            String(msg.hint ?? ""),
            msg.purpose === "wake" ? "wake" : "command",
          )
          break
        case "confirm":
          await this.resolvePending(Boolean(msg.accept))
          break
        case "setup":
          await this.handleSetup(String(msg.action))
          break
        case "setSetting": {
          const ok = await updateSetting(String(msg.key), msg.value)
          if (!ok) this.broadcast({ type: "error", message: `Invalid value for ${msg.key}` })
          await this.sendState()
          break
        }
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
    const provider = this.resolveProvider()
    const speechKey = await this.keys.speechReady(provider)
    const tree = await snapshotTree()
    const listeningChosen = this.context.globalState.get<boolean>("digitalTwinVoice.listeningChosen", false)
    const brain = await this.resolveBrain()
    this.broadcast({
      type: "state",
      enabled: s.enabled,
      brain: s.brain,
      brainActive: brain ?? null,
      model: s.model,
      provider,
      providerSetting: s.provider,
      sttMode: provider === "browser" ? "browser" : "record",
      serverStt: {
        available: this.serverStt.available ?? null,
        model: this.serverStt.model,
        error: this.serverStt.lastError,
      },
      vocabulary: vocabulary(this.registry, tree).slice(0, 40),
      language: s.language,
      speakReplies: s.speakReplies,
      listening: {
        mode: s.listeningMode,
        wakePhrase: s.wakePhrase,
        wakeAliases: s.wakeAliases,
        endWord: s.endWord,
        pauseSeconds: s.pauseSeconds,
        maxCommandSeconds: s.maxCommandSeconds,
        autoStart: s.autoStart,
        chime: s.chime,
        preferOnDevice: s.preferOnDevice,
        enhanceMic: s.enhanceMic,
      },
      confirmation: { mode: s.confirmationMode, countdownSeconds: s.countdownSeconds },
      setup: {
        anthropic,
        brainReady: Boolean(brain),
        listeningChosen,
        claudeLogin: claudeCodeLoggedIn(),
        claudeInstalled: claudeCodeInstalled(),
        speechKey,
        complete: Boolean(brain) && speechKey && listeningChosen,
      },
      terminals: this.registry.list(),
      recording: this.recording,
      handsFreeOwner: this.handsFreeOwner ?? null,
      remoteRunning: this.remote.running,
    })
  }

  private refreshStatusBar(): void {
    const s = settings()
    if (!s.enabled) {
      this.status.hide()
      return
    }
    if (this.recording) {
      this.status.text = "$(record) Listening…"
      this.status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground")
    } else if (this.handsFreeOwner) {
      this.status.text = `$(unmute) "${s.wakePhrase}"`
      this.status.backgroundColor = undefined
    } else {
      this.status.text = "$(mic) Voice"
      this.status.backgroundColor = undefined
    }
    this.status.tooltip = this.handsFreeOwner
      ? `Voice Control: listening for "${s.wakePhrase}". Click to talk now.`
      : "Voice Control: click or press Ctrl+Shift+Space to talk"
    this.status.show()
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
    if (!settings().enabled) return
    await this.panel.reveal()
    this.broadcast({ type: "record", start: !this.recording })
  }

  async toggleHandsFree(): Promise<void> {
    if (!settings().enabled) return
    await this.panel.reveal()
    this.broadcast({ type: "handsFree", start: !this.handsFreeOwner })
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
    this.output.appendLine(`Voice Remote listening on 127.0.0.1:${port}`)
    const choice = await vscode.window.showInformationMessage(
      "Voice Remote is ready. Open it here, or copy the link and open it on your phone or tablet (you must be logged in to this IDE there too).",
      "Open here",
      "Copy link",
    )
    if (choice === "Open here") await vscode.env.openExternal(vscode.Uri.parse(url))
    else if (choice === "Copy link") {
      await vscode.env.clipboard.writeText(url)
      vscode.window.showInformationMessage("Link copied. It carries a one-time token valid until the IDE restarts.")
    }
    await this.sendState()
  }

  // ---------------------------------------------------------------- setup

  private async handleSetup(action: string): Promise<void> {
    switch (action) {
      case "anthropicKey":
        await updateSetting("brain", "apiKey")
        await this.setAnthropicKey()
        break
      case "claudeAccount":
        await updateSetting("brain", "claudeAccount")
        if (!claudeCodeLoggedIn()) await this.claudeLogin()
        break
      case "speechKey":
        await this.setSpeechKey()
        break
      case "provider":
        await this.chooseProvider()
        break
      case "listening":
        await this.chooseListening()
        break
      case "claudeLogin":
        await this.claudeLogin()
        break
      case "wizard":
        await this.runWizard()
        break
    }
    await this.sendState()
  }

  /** Guided first-run flow: key → listening → Claude login → speech engine. */
  async runWizard(): Promise<void> {
    await this.panel.reveal()
    if (!(await this.resolveBrain())) {
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: "$(account) Use my Claude account",
            description: "same login as the claude terminal command, no API key",
            detail: "Runs Claude Code headless for each command (about 3 seconds). You log in once in a terminal.",
            id: "claudeAccount",
          },
          {
            label: "$(key) Use an Anthropic API key",
            description: "fastest, billed per use",
            detail: "Calls the Messages API directly (1-2 seconds). Key is stored encrypted on this server.",
            id: "apiKey",
          },
        ],
        { title: "Step 1 of 4 · What should understand you?", ignoreFocusOut: true },
      )
      if (!pick) return
      await updateSetting("brain", pick.id)
      if (pick.id === "apiKey") {
        await this.setAnthropicKey()
        if (!(await this.keys.anthropic())) return
      } else if (!claudeCodeLoggedIn()) {
        await this.claudeLogin()
      }
    }
    await this.chooseListening()
    if (settings().brain === "apiKey" && !claudeCodeLoggedIn()) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: "Log in now", description: "opens Claude Code in a terminal; follow its prompt", id: "login" },
          { label: "Skip for now", description: '"ask Claude …" commands will not work until you log in', id: "skip" },
        ],
        { title: "Step 3 of 4 · Claude Code login", ignoreFocusOut: true },
      )
      if (pick?.id === "login") await this.claudeLogin()
    }
    await this.chooseProvider("Step 4 of 4 · Speech engine")
    vscode.window.showInformationMessage(
      'Voice Control is ready. Tap the microphone or press Ctrl+Shift+Space and say something like "open a terminal in src".',
    )
  }

  async setAnthropicKey(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: "Step 1 of 4 · Anthropic API key",
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
      this.output.appendLine(`[setup] key check skipped: ${errorText(err)}`)
    }
    await this.keys.set(SECRET_ANTHROPIC, value)
    vscode.window.showInformationMessage("Voice Control: Anthropic key saved.")
    await this.sendState()
  }

  async chooseListening(): Promise<void> {
    const s = settings()
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "$(mic) Push-to-talk",
          description: "recommended",
          detail: "Listens only after you tap the microphone or press Ctrl+Shift+Space. Nothing is heard otherwise.",
          id: "pushToTalk",
        },
        {
          label: "$(unmute) Wake word (hands-free)",
          description: `say "${s.wakePhrase}" then your command`,
          detail:
            "Keeps the microphone open while the Voice panel is visible. Uses your browser's speech recognition (on-device on Chrome 139+, otherwise the browser vendor's service).",
          id: "wakeWord",
        },
      ],
      { title: "Step 2 of 4 · How should listening start?", ignoreFocusOut: true },
    )
    if (!pick) return
    await updateSetting("listening.mode", pick.id)
    if (pick.id === "wakeWord") {
      const phrase = await vscode.window.showInputBox({
        title: "Wake phrase",
        prompt:
          "Two or more words trigger far less by accident. Examples: Hey Twin · OK Twin · Computer listen · Jarvis",
        value: s.wakePhrase,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().length >= 3 ? undefined : "Use at least 3 letters"),
      })
      if (phrase) await updateSetting("listening.wakePhrase", phrase)
      const endWord = await vscode.window.showInputBox({
        title: "End word (optional)",
        prompt: `Say this to finish a command immediately, e.g. "over" or "execute". Leave empty to finish by pausing ${s.pauseSeconds}s. A pause always works too.`,
        value: s.endWord,
        ignoreFocusOut: true,
      })
      if (endWord !== undefined) await updateSetting("listening.endWord", endWord)
      const confirm = await vscode.window.showQuickPick(
        [
          {
            label: "Show what I heard, then run after a 5-second countdown",
            description: 'say "cancel" to stop',
            id: "countdown",
          },
          { label: "Ask me every time", description: 'nothing runs until you say "yes"', id: "ask" },
          { label: "Run immediately", description: "destructive commands still ask", id: "auto" },
        ],
        { title: "Confirmation", ignoreFocusOut: true },
      )
      if (confirm) await updateSetting("confirmation.mode", confirm.id)
    }
    await this.context.globalState.update("digitalTwinVoice.listeningChosen", true)
    await this.sendState()
  }

  async chooseProvider(title = "Speech engine"): Promise<void> {
    const picks: Array<vscode.QuickPickItem & { id: SpeechProvider }> = []
    if (this.serverStt.available) {
      picks.push({
        id: "server",
        label: "$(server) Built-in (Whisper on this server)",
        description: "free, no key, every browser",
        detail:
          "Audio never leaves the server. Works in Comet, Brave, Firefox and on phones. A second or two per command.",
      })
    }
    picks.push(
      {
        id: "browser",
        label: "Browser speech recognition",
        description: "free, no key, Chrome/Edge/Safari only",
        detail: "Fine for short commands. Weakest on technical words; audio goes to the browser vendor.",
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
    )
    const pick = await vscode.window.showQuickPick(picks, { title, ignoreFocusOut: true })
    if (!pick) return
    await updateSetting("speech.provider", pick.id)
    if ((pick.id === "openai" || pick.id === "deepgram") && !(await this.keys.speech(pick.id)))
      await this.setSpeechKey(pick.id)
    await this.sendState()
  }

  async setSpeechKey(provider: SpeechProvider = settings().provider): Promise<void> {
    if (provider === "auto" || provider === "server" || provider === "browser") {
      vscode.window.showInformationMessage(
        "The built-in and browser speech engines need no key. Choose OpenAI or Deepgram for a key-based engine.",
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
    this.watchForLogin()
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

  async start(): Promise<void> {
    await this.applySeed()
    await this.maybeShowFirstRun()
  }

  async maybeShowFirstRun(): Promise<void> {
    if (!settings().enabled) return
    if (this.context.globalState.get<boolean>(FIRST_RUN_KEY)) return
    await this.context.globalState.update(FIRST_RUN_KEY, true)
    if (await this.resolveBrain()) return
    const choice = await vscode.window.showInformationMessage(
      "Voice Control is installed: talk to your Digital Twin to open terminals, run commands and hand tasks to Claude Code. It stays silent until you set it up.",
      "Set up now",
      "Later",
      "Turn off",
    )
    if (choice === "Set up now") await this.runWizard()
    else if (choice === "Turn off") {
      await vscode.workspace
        .getConfiguration("digitalTwinVoice")
        .update("enabled", false, vscode.ConfigurationTarget.Global)
    }
  }

  // ---------------------------------------------------------------- pipeline

  private async handleAudio(base64: string, mime: string, hint: string, purpose: "command" | "wake"): Promise<void> {
    const s = settings()
    const provider = this.resolveProvider()
    let text: string
    if (provider === "browser") {
      text = hint
    } else {
      const audio = Buffer.from(base64, "base64")
      if (audio.length < 1000) {
        if (purpose === "command") this.phase("idle", "Too short, try again")
        return
      }
      if (purpose === "command")
        this.phase("transcribing", provider === "server" ? "Transcribing on this server…" : "Transcribing…")
      const tree = await snapshotTree()
      const apiKey = (await this.keys.speech(provider)) || ""
      if ((provider === "openai" || provider === "deepgram") && !apiKey) {
        this.broadcast({ type: "error", message: `No ${provider} API key. Add one in Settings.` })
        return
      }
      try {
        text = await transcribe({
          provider,
          apiKey,
          server: this.serverStt,
          audio,
          mime,
          language: s.language,
          vocabulary: vocabulary(this.registry, tree),
          openaiModel: s.openaiModel,
          deepgramModel: s.deepgramModel,
        })
      } catch (err) {
        if (hint) {
          this.output.appendLine(`[stt] ${errorText(err)}; falling back to browser transcript`)
          text = hint
        } else if (purpose === "wake") {
          this.output.appendLine(`[wake] ${errorText(err)}`)
          this.broadcast({ type: "wakeResult", matched: false, error: errorText(err) })
          return
        } else throw err
      }
    }
    if (purpose === "wake") {
      const after = matchWake(text, s.wakePhrase, s.wakeAliases)
      if (after === null) {
        this.output.appendLine(`[wake] ignored: ${text.slice(0, 80)}`)
        this.broadcast({ type: "wakeResult", matched: false })
        return
      }
      const hasCommand = after.split(" ").filter(Boolean).length >= 2
      this.output.appendLine(`[wake] heard "${s.wakePhrase}"${hasCommand ? ` + command: ${after}` : ""}`)
      this.broadcast({ type: "wakeResult", matched: true, command: hasCommand })
      if (hasCommand) await this.handleTranscript(after)
      return
    }
    await this.handleTranscript(text)
  }

  private async handleTranscript(raw: string): Promise<void> {
    const s = settings()
    let text = raw.trim()
    if (s.endWord) text = stripEndWord(text, s.endWord)
    this.broadcast({ type: "transcript", text })
    if (!text) {
      this.phase("idle", "Didn't hear anything")
      return
    }
    if (this.pending) {
      if (YES.test(text)) return this.resolvePending(true)
      if (NO.test(text)) return this.resolvePending(false)
      await this.resolvePending(false, true)
    }
    if (STOP_LISTENING.test(text)) {
      this.broadcast({ type: "handsFree", start: false })
      this.broadcast({
        type: "actions",
        heard: text,
        items: [],
        needsConfirm: false,
        countdown: 0,
        say: "Okay, I stopped listening.",
      })
      this.phase("idle")
      return
    }
    if (this.busy) {
      this.broadcast({ type: "error", message: "Still working on the previous request." })
      return
    }
    const brain = await this.resolveBrain()
    if (!brain) {
      this.broadcast({
        type: "error",
        message:
          s.brain === "claudeAccount"
            ? "Claude Code is not logged in yet. Run `claude` in a terminal and sign in (Settings → Claude login)."
            : "Nothing can understand you yet: log in to your Claude account or add an Anthropic API key (Settings).",
      })
      return
    }
    this.busy = true
    try {
      this.phase("thinking", brain === "claudeAccount" ? "Asking Claude (your account)…" : "Thinking…")
      const tree = await snapshotTree()
      this.output.appendLine(`[you] ${text}`)
      const context = buildContext(this.registry, tree)
      const result =
        brain === "apiKey"
          ? await interpret({ apiKey: (await this.keys.anthropic())!, model: s.model, transcript: text, context })
          : await interpretViaClaudeCode({ claudePath: findClaudeBinary()!, model: s.model, transcript: text, context })
      this.output.appendLine(`[claude] ${JSON.stringify(result)}`)
      const items = result.actions.map((a) => ({ label: describe(a), dangerous: isDangerous(a) }))
      const dangerous = s.confirmDangerous && items.some((i) => i.dangerous)
      const explicit = result.actions.length > 0 && (dangerous || s.confirmationMode === "ask")
      const countdown =
        !explicit && result.actions.length > 0 && s.confirmationMode === "countdown" ? s.countdownSeconds : 0
      this.broadcast({ type: "actions", heard: text, items, needsConfirm: explicit, countdown, say: result.say })
      if (!result.actions.length) {
        this.phase("idle")
        return
      }
      if (explicit || countdown) {
        this.clearPending()
        const pending: Pending = { actions: result.actions, heard: text }
        pending.timer = setTimeout(() => void this.resolvePending(Boolean(countdown)), (countdown || 90) * 1000)
        this.pending = pending
        this.phase("confirm", countdown ? `Running in ${countdown}s unless you cancel` : "Waiting for confirmation")
        return
      }
      await this.runActions(result.actions, tree)
    } finally {
      this.busy = false
    }
  }

  private clearPending(): void {
    if (this.pending?.timer) clearTimeout(this.pending.timer)
    this.pending = undefined
  }

  private async resolvePending(accept: boolean, silent = false): Promise<void> {
    const pending = this.pending
    this.clearPending()
    if (!pending) return
    this.broadcast({ type: "pendingResolved", accepted: accept })
    if (!accept) {
      if (!silent)
        this.broadcast({
          type: "actions",
          heard: pending.heard,
          items: [],
          needsConfirm: false,
          countdown: 0,
          say: "Cancelled.",
        })
      this.phase("idle")
      return
    }
    await this.runActions(pending.actions, await snapshotTree())
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

/** Remove a trailing end word such as "over" or "execute" (with punctuation). */
export function stripEndWord(text: string, endWord: string): string {
  const escaped = endWord
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+")
  if (!escaped) return text
  return text.replace(new RegExp(`[\\s,.!?]*\\b${escaped}\\b[\\s.!?,]*$`, "i"), "").trim()
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
    vscode.commands.registerCommand("digitalTwinVoice.toggleHandsFree", () => controller.toggleHandsFree()),
    vscode.commands.registerCommand("digitalTwinVoice.openPanel", () =>
      vscode.commands.executeCommand("digitalTwinVoice.panel.focus"),
    ),
    vscode.commands.registerCommand("digitalTwinVoice.openInBrowser", () => controller.openRemote()),
    vscode.commands.registerCommand("digitalTwinVoice.typeCommand", () => controller.typeCommand()),
    vscode.commands.registerCommand("digitalTwinVoice.setup", () => controller.runWizard()),
    vscode.commands.registerCommand("digitalTwinVoice.setAnthropicKey", () => controller.setAnthropicKey()),
    vscode.commands.registerCommand("digitalTwinVoice.setSpeechKey", () => controller.setSpeechKey()),
    vscode.commands.registerCommand("digitalTwinVoice.claudeLogin", () => controller.claudeLogin()),
    vscode.commands.registerCommand("digitalTwinVoice.clearKeys", () => controller.clearKeys()),
  )
  void controller.start()
}

export function deactivate(): void {
  // subscriptions handle cleanup
}
