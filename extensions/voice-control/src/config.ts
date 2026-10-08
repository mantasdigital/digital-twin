import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

export type SpeechProvider = "browser" | "openai" | "deepgram"
export type ListeningMode = "pushToTalk" | "wakeWord"
export type ConfirmationMode = "ask" | "countdown" | "auto"
/** What turns speech into actions: the Messages API with a key, or the user's Claude account via headless Claude Code. */
export type Brain = "auto" | "claudeAccount" | "apiKey"

export const SECRET_ANTHROPIC = "digitalTwinVoice.anthropicApiKey"
export const SECRET_OPENAI = "digitalTwinVoice.openaiApiKey"
export const SECRET_DEEPGRAM = "digitalTwinVoice.deepgramApiKey"

export interface Settings {
  enabled: boolean
  brain: Brain
  model: string
  provider: SpeechProvider
  language: string
  openaiModel: string
  deepgramModel: string
  listeningMode: ListeningMode
  wakePhrase: string
  wakeAliases: string[]
  endWord: string
  pauseSeconds: number
  maxCommandSeconds: number
  autoStart: boolean
  chime: boolean
  preferOnDevice: boolean
  confirmationMode: ConfirmationMode
  countdownSeconds: number
  confirmDangerous: boolean
  speakReplies: boolean
  remotePort: number
}

export function settings(): Settings {
  const c = vscode.workspace.getConfiguration("digitalTwinVoice")
  return {
    enabled: c.get<boolean>("enabled", true),
    brain: c.get<Brain>("brain", "auto"),
    model: c.get<string>("model", "claude-opus-5-5"),
    provider: c.get<SpeechProvider>("speech.provider", "browser"),
    language: c.get<string>("speech.language", "").trim(),
    openaiModel: c.get<string>("speech.openaiModel", "gpt-4o-transcribe"),
    deepgramModel: c.get<string>("speech.deepgramModel", "nova-3"),
    listeningMode: c.get<ListeningMode>("listening.mode", "pushToTalk"),
    wakePhrase: c.get<string>("listening.wakePhrase", "Hey Twin").trim() || "Hey Twin",
    wakeAliases: c.get<string[]>("listening.wakeAliases", []).filter((s) => s && s.trim()),
    endWord: c.get<string>("listening.endWord", "").trim(),
    pauseSeconds: clamp(c.get<number>("listening.pauseSeconds", 6), 1.5, 30),
    maxCommandSeconds: clamp(c.get<number>("listening.maxCommandSeconds", 60), 10, 300),
    autoStart: c.get<boolean>("listening.autoStart", true),
    chime: c.get<boolean>("listening.chime", true),
    preferOnDevice: c.get<boolean>("listening.preferOnDevice", true),
    confirmationMode: c.get<ConfirmationMode>("confirmation.mode", "countdown"),
    countdownSeconds: clamp(c.get<number>("confirmation.countdownSeconds", 5), 2, 30),
    confirmDangerous: c.get<boolean>("confirmDangerous", true),
    speakReplies: c.get<boolean>("speakReplies", true),
    remotePort: c.get<number>("remotePort", 39339),
  }
}

/** Settings the panel UI (including the phone remote) may change. */
export const EDITABLE_SETTINGS: Record<string, (v: unknown) => unknown | undefined> = {
  brain: (v) => (v === "auto" || v === "claudeAccount" || v === "apiKey" ? v : undefined),
  "listening.mode": (v) => (v === "pushToTalk" || v === "wakeWord" ? v : undefined),
  "listening.wakePhrase": (v) => (typeof v === "string" && v.trim().length >= 3 ? v.trim().slice(0, 40) : undefined),
  "listening.wakeAliases": (v) =>
    Array.isArray(v)
      ? v
          .filter((s) => typeof s === "string" && s.trim())
          .map((s) => s.trim().slice(0, 40))
          .slice(0, 10)
      : undefined,
  "listening.endWord": (v) => (typeof v === "string" ? v.trim().slice(0, 30) : undefined),
  "listening.pauseSeconds": (v) => (typeof v === "number" && isFinite(v) ? clamp(v, 1.5, 30) : undefined),
  "listening.autoStart": (v) => (typeof v === "boolean" ? v : undefined),
  "listening.chime": (v) => (typeof v === "boolean" ? v : undefined),
  "confirmation.mode": (v) => (v === "ask" || v === "countdown" || v === "auto" ? v : undefined),
  "confirmation.countdownSeconds": (v) => (typeof v === "number" && isFinite(v) ? clamp(v, 2, 30) : undefined),
  "speech.provider": (v) => (v === "browser" || v === "openai" || v === "deepgram" ? v : undefined),
  "speech.language": (v) => (typeof v === "string" ? v.trim().slice(0, 12) : undefined),
  speakReplies: (v) => (typeof v === "boolean" ? v : undefined),
}

export async function updateSetting(key: string, value: unknown): Promise<boolean> {
  const validate = EDITABLE_SETTINGS[key]
  if (!validate) return false
  const clean = validate(value)
  if (clean === undefined) return false
  await vscode.workspace.getConfiguration("digitalTwinVoice").update(key, clean, vscode.ConfigurationTarget.Global)
  return true
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * API keys. Environment variables (set as Railway variables) win so a deployment
 * can be configured with zero clicks; otherwise keys live in VS Code's
 * SecretStorage, which code-server keeps server-side in the user data dir.
 */
export class Keys {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async anthropic(): Promise<string | undefined> {
    return process.env.ANTHROPIC_API_KEY || (await this.secrets.get(SECRET_ANTHROPIC)) || undefined
  }

  async openai(): Promise<string | undefined> {
    return process.env.OPENAI_API_KEY || (await this.secrets.get(SECRET_OPENAI)) || undefined
  }

  async deepgram(): Promise<string | undefined> {
    return process.env.DEEPGRAM_API_KEY || (await this.secrets.get(SECRET_DEEPGRAM)) || undefined
  }

  async speech(provider: SpeechProvider): Promise<string | undefined> {
    if (provider === "openai") return this.openai()
    if (provider === "deepgram") return this.deepgram()
    return undefined
  }

  async set(secret: string, value: string): Promise<void> {
    await this.secrets.store(secret, value.trim())
  }

  async clearAll(): Promise<void> {
    await Promise.all([SECRET_ANTHROPIC, SECRET_OPENAI, SECRET_DEEPGRAM].map((s) => this.secrets.delete(s)))
  }
}

/**
 * Whether Claude Code on this machine has credentials. Claude Code stores its
 * OAuth tokens in ~/.claude/.credentials.json; an exported ANTHROPIC_API_KEY
 * also works for it.
 */
export function claudeCodeLoggedIn(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true
  const home = os.homedir()
  if (fs.existsSync(path.join(home, ".claude", ".credentials.json"))) return true
  try {
    const raw = fs.readFileSync(path.join(home, ".claude.json"), "utf8")
    const json = JSON.parse(raw)
    return Boolean(json.oauthAccount || json.primaryApiKey)
  } catch {
    return false
  }
}

export function findClaudeBinary(): string | undefined {
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "claude"),
    path.join(os.homedir(), ".claude", "local", "claude"),
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ]
  for (const d of (process.env.PATH || "").split(path.delimiter)) if (d) candidates.push(path.join(d, "claude"))
  return candidates.find((p) => fs.existsSync(p))
}

export function claudeCodeInstalled(): boolean {
  return Boolean(findClaudeBinary())
}

/**
 * Defaults chosen on the server's post-2FA "Voice Control" page. Written by
 * the Digital Twin server into the code-server config dir; consumed once.
 */
export interface VoiceSeed {
  version: number
  enabled?: boolean
  listeningMode?: "pushToTalk" | "wakeWord"
  wakePhrase?: string
  brain?: "claudeAccount" | "apiKey"
  anthropicApiKey?: string
}

export function seedFileCandidates(): string[] {
  const xdg = process.env.XDG_CONFIG_HOME
  const out = [path.join(os.homedir(), ".config", "code-server", "voice-control-seed.json")]
  if (xdg) out.unshift(path.join(xdg, "code-server", "voice-control-seed.json"))
  return out
}
