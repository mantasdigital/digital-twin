import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

export type SpeechProvider = "browser" | "openai" | "deepgram"

export const SECRET_ANTHROPIC = "digitalTwinVoice.anthropicApiKey"
export const SECRET_OPENAI = "digitalTwinVoice.openaiApiKey"
export const SECRET_DEEPGRAM = "digitalTwinVoice.deepgramApiKey"

export interface Settings {
  model: string
  provider: SpeechProvider
  language: string
  openaiModel: string
  deepgramModel: string
  confirmDangerous: boolean
  speakReplies: boolean
  remotePort: number
}

export function settings(): Settings {
  const c = vscode.workspace.getConfiguration("digitalTwinVoice")
  return {
    model: c.get<string>("model", "claude-opus-5-5"),
    provider: c.get<SpeechProvider>("speech.provider", "browser"),
    language: c.get<string>("speech.language", "").trim(),
    openaiModel: c.get<string>("speech.openaiModel", "gpt-4o-transcribe"),
    deepgramModel: c.get<string>("speech.deepgramModel", "nova-3"),
    confirmDangerous: c.get<boolean>("confirmDangerous", true),
    speakReplies: c.get<boolean>("speakReplies", true),
    remotePort: c.get<number>("remotePort", 39339),
  }
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

export function claudeCodeInstalled(): boolean {
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "claude"),
    path.join(os.homedir(), ".claude", "local", "claude"),
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ]
  if (candidates.some((p) => fs.existsSync(p))) return true
  const dirs = (process.env.PATH || "").split(path.delimiter)
  return dirs.some((d) => d && fs.existsSync(path.join(d, "claude")))
}
