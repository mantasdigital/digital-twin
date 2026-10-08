import { Router, Request } from "express"
import { promises as fs } from "fs"
import * as path from "path"
import { rootPath } from "../constants"
import { ensureAuthenticated, ensureOrigin, redirect, replaceTemplates } from "../http"
import i18n from "../i18n"
import { escapeHtml, paths, sanitizeString } from "../util"

/**
 * Per-user Voice Control defaults, chosen right after two-factor enrollment.
 *
 * The choices are written to a seed file in the code-server config dir. The
 * bundled Voice Control extension reads it on its next activation, applies the
 * settings (and moves an API key into SecretStorage), then deletes the file.
 * This keeps the server ignorant of extension internals and the key out of any
 * world-readable settings file.
 */
export const SEED_FILE = path.join(paths.config, "voice-control-seed.json")

export interface VoiceSeed {
  version: 1
  createdAt: string
  enabled: boolean
  listeningMode: "pushToTalk" | "wakeWord"
  wakePhrase?: string
  brain: "claudeAccount" | "apiKey"
  anthropicApiKey?: string
}

export const voiceControlShipped = (): boolean => (process.env.DIGITAL_TWIN_BUNDLED_EXTENSIONS || "on") !== "off"

const render = async (req: Request, error?: Error): Promise<string> => {
  const content = await fs.readFile(path.join(rootPath, "src/browser/pages/voice-setup.html"), "utf8")
  const locale = req.args["locale"] || "en"
  i18n.changeLanguage(locale)
  const keys = [
    "VOICE_TITLE",
    "VOICE_INTRO",
    "VOICE_ENABLE_LABEL",
    "VOICE_ENABLE_ON",
    "VOICE_ENABLE_OFF",
    "VOICE_LISTENING_LABEL",
    "VOICE_LISTENING_PTT",
    "VOICE_LISTENING_WAKE",
    "VOICE_WAKE_NOTE",
    "VOICE_BRAIN_LABEL",
    "VOICE_BRAIN_ACCOUNT",
    "VOICE_BRAIN_KEY",
    "VOICE_BRAIN_NOTE",
    "VOICE_OPTIONAL",
    "VOICE_SUBMIT",
    "VOICE_SKIP",
  ]
  let html = content
  for (const key of keys) {
    html = html.replace(new RegExp(`{{I18N_${key}}}`, "g"), () => escapeHtml(i18n.t(key) as string))
  }
  return replaceTemplates(
    req,
    html.replace(/{{ERROR}}/, error ? `<div class="error">${escapeHtml(error.message)}</div>` : ""),
  )
}

export const router = Router()

router.get("/", ensureAuthenticated, async (req, res) => {
  res.send(await render(req))
})

interface VoiceSetupBody {
  voice?: string
  listening?: string
  "wake-phrase"?: string
  brain?: string
  "anthropic-key"?: string
  skip?: string
}

router.post<{}, string, VoiceSetupBody | undefined, { to?: string }>(
  "/",
  ensureOrigin,
  ensureAuthenticated,
  async (req, res) => {
    const to = (typeof req.query.to === "string" && req.query.to) || "/"
    const body = req.body || {}
    if (sanitizeString(body.skip)) {
      return redirect(req, res, to, { to: undefined })
    }
    try {
      const key = sanitizeString(body["anthropic-key"])
      const brain = sanitizeString(body.brain) === "apiKey" ? "apiKey" : "claudeAccount"
      if (key && !key.startsWith("sk-ant-")) {
        throw new Error(i18n.t("VOICE_BAD_KEY") as string)
      }
      if (brain === "apiKey" && !key) {
        throw new Error(i18n.t("VOICE_KEY_REQUIRED") as string)
      }
      const seed: VoiceSeed = {
        version: 1,
        createdAt: new Date().toISOString(),
        enabled: sanitizeString(body.voice) !== "off",
        listeningMode: sanitizeString(body.listening) === "wakeWord" ? "wakeWord" : "pushToTalk",
        wakePhrase: sanitizeString(body["wake-phrase"]).slice(0, 40) || undefined,
        brain,
        anthropicApiKey: key || undefined,
      }
      await fs.mkdir(path.dirname(SEED_FILE), { recursive: true })
      await fs.writeFile(SEED_FILE, JSON.stringify(seed, null, 2), { mode: 0o600 })
      return redirect(req, res, to, { to: undefined })
    } catch (error: any) {
      res.send(await render(req, error))
    }
  },
)
