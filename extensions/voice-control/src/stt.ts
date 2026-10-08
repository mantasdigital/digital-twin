import { ChildProcessWithoutNullStreams, execFile, spawn } from "child_process"
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

/**
 * Speech-to-text behind the panel. The browser provider needs nothing here
 * (the webview sends finished text). The built-in server provider runs a
 * long-lived faster-whisper worker on this machine; OpenAI and Deepgram
 * receive the recorded clip. Node 22 provides fetch, FormData and Blob.
 */

export interface TranscribeOptions {
  provider: "server" | "openai" | "deepgram"
  apiKey: string
  server?: ServerStt
  audio: Buffer
  mime: string
  language: string
  vocabulary: string[]
  openaiModel: string
  deepgramModel: string
}

export async function transcribe(opts: TranscribeOptions): Promise<string> {
  if (opts.provider === "server") {
    if (!opts.server) throw new Error("Built-in speech engine is not available on this image.")
    return opts.server.transcribe(opts.audio, opts.mime, opts.language, opts.vocabulary)
  }
  if (opts.provider === "openai") return transcribeOpenAI(opts)
  return transcribeDeepgram(opts)
}

// ---------------------------------------------------------------------------
// Built-in server engine: python worker (stt/whisper_worker.py), JSON lines.
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (text: string) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class ServerStt {
  /** undefined until probed; then whether python3 can import faster_whisper. */
  available: boolean | undefined
  lastError = ""
  model = ""
  private proc: ChildProcessWithoutNullStreams | undefined
  private ready: Promise<void> | undefined
  private readonly pending = new Map<string, Pending>()
  private buffer = ""

  constructor(
    readonly workerPath: string | undefined,
    private readonly log: (line: string) => void,
  ) {}

  /** Interpreter with faster-whisper: the image's venv, an override, or plain python3. */
  static pythonBinary(): string {
    const candidates = [process.env.DIGITAL_TWIN_STT_PYTHON || "", "/opt/digital-twin/stt/venv/bin/python"]
    return candidates.find((p) => p && fs.existsSync(p)) || "python3"
  }

  static findWorker(extensionPath: string): string | undefined {
    const candidates = [
      process.env.DIGITAL_TWIN_STT_WORKER || "",
      "/opt/digital-twin/stt/whisper_worker.py",
      path.join(extensionPath, "..", "..", "stt", "whisper_worker.py"), // repo checkout
    ]
    return candidates.find((p) => p && fs.existsSync(p))
  }

  /** Cheap check (no model load): is the python side installed? */
  async probe(): Promise<boolean> {
    if (!this.workerPath || process.env.DIGITAL_TWIN_STT === "off") {
      this.available = false
      this.lastError = this.workerPath ? "disabled (DIGITAL_TWIN_STT=off)" : "worker script not found"
      return false
    }
    return new Promise((resolve) => {
      execFile(
        ServerStt.pythonBinary(),
        ["-c", "import faster_whisper, av, ctranslate2"],
        { timeout: 30_000 },
        (err, _out, stderr) => {
          this.available = !err
          this.lastError = err
            ? String(stderr || err.message)
                .split("\n")
                .slice(-1)[0]
            : ""
          if (err) this.log(`[stt] built-in engine unavailable: ${this.lastError}`)
          resolve(!err)
        },
      )
    })
  }

  private ensure(): Promise<void> {
    if (this.proc && this.ready) return this.ready
    const proc = spawn(ServerStt.pythonBinary(), [this.workerPath!], {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.proc = proc
    this.buffer = ""
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Built-in speech engine took too long to start")), 180_000)
      proc.stdout.on("data", (chunk) => {
        this.buffer += chunk.toString()
        let idx: number
        while ((idx = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, idx).trim()
          this.buffer = this.buffer.slice(idx + 1)
          if (!line) continue
          let msg: any
          try {
            msg = JSON.parse(line)
          } catch {
            this.log(`[stt] ${line}`)
            continue
          }
          if ("ready" in msg) {
            clearTimeout(timer)
            if (msg.ready) {
              this.model = String(msg.model || "")
              this.log(`[stt] built-in engine ready (model ${this.model}, ${msg.load_ms} ms)`)
              resolve()
            } else {
              this.lastError = String(msg.error || "unknown error")
              reject(new Error(`Built-in speech engine failed to start: ${this.lastError}`))
            }
            continue
          }
          const p = msg.id ? this.pending.get(String(msg.id)) : undefined
          if (!p) continue
          this.pending.delete(String(msg.id))
          clearTimeout(p.timer)
          if (msg.error) p.reject(new Error(`Built-in speech engine: ${msg.error}`))
          else {
            this.log(`[stt] ${msg.seconds ?? "?"}s of audio -> ${msg.ms} ms`)
            p.resolve(String(msg.text ?? ""))
          }
        }
      })
      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString().trim()
        if (text && !/Warning: You are sending unauthenticated/.test(text)) this.log(`[stt:py] ${text.slice(0, 300)}`)
      })
      proc.on("exit", (code, signal) => {
        this.log(`[stt] worker exited (${code ?? signal})`)
        for (const p of this.pending.values()) {
          clearTimeout(p.timer)
          p.reject(new Error("Built-in speech engine stopped"))
        }
        this.pending.clear()
        this.proc = undefined
        this.ready = undefined
      })
      proc.on("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    return this.ready
  }

  async transcribe(audio: Buffer, mime: string, language: string, vocabulary: string[]): Promise<string> {
    await this.ensure()
    const id = crypto.randomBytes(6).toString("hex")
    const file = path.join(os.tmpdir(), `dtv-${id}.${extensionFor(mime)}`)
    await fs.promises.writeFile(file, audio, { mode: 0o600 })
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        fs.promises.unlink(file).catch(() => undefined)
        reject(new Error("Built-in speech engine timed out"))
      }, 90_000)
      this.pending.set(id, { resolve, reject, timer })
      this.proc!.stdin.write(JSON.stringify({ id, file, language, prompt: vocabulary.join(", "), delete: true }) + "\n")
    })
  }

  dispose(): void {
    this.proc?.kill()
    this.proc = undefined
    this.ready = undefined
  }
}

function extensionFor(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes("webm")) return "webm"
  if (m.includes("ogg")) return "ogg"
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "mp4"
  if (m.includes("wav")) return "wav"
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3"
  return "webm"
}

/** "en-US" -> "en" (OpenAI wants ISO-639-1). */
function iso639(language: string): string {
  return language.split(/[-_]/)[0].toLowerCase()
}

async function transcribeOpenAI(opts: TranscribeOptions): Promise<string> {
  const form = new FormData()
  const blob = new Blob([new Uint8Array(opts.audio)], { type: opts.mime.split(";")[0] })
  form.append("file", blob, `clip.${extensionFor(opts.mime)}`)
  form.append("model", opts.openaiModel)
  form.append("response_format", "json")
  if (opts.language) form.append("language", iso639(opts.language))
  if (opts.vocabulary.length) {
    // The prompt biases recognition toward these spellings.
    form.append("prompt", `Developer dictation in VS Code. Terms: ${opts.vocabulary.join(", ")}.`)
  }
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    body: form,
  })
  if (!res.ok) {
    throw new Error(`OpenAI transcription failed (${res.status}): ${truncate(await res.text())}`)
  }
  const json = (await res.json()) as { text?: string }
  return (json.text ?? "").trim()
}

async function transcribeDeepgram(opts: TranscribeOptions): Promise<string> {
  const params = new URLSearchParams()
  params.set("model", opts.deepgramModel)
  params.set("smart_format", "true")
  params.set("punctuate", "true")
  if (opts.language) params.set("language", opts.language)
  // Nova-3 takes "keyterm" hints; older models use "keywords".
  const hintParam = /nova-3/.test(opts.deepgramModel) ? "keyterm" : "keywords"
  for (const term of opts.vocabulary.slice(0, 50)) params.append(hintParam, term)

  const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Token ${opts.apiKey}`, "Content-Type": opts.mime.split(";")[0] },
    body: new Uint8Array(opts.audio),
  })
  if (!res.ok) {
    throw new Error(`Deepgram transcription failed (${res.status}): ${truncate(await res.text())}`)
  }
  const json = (await res.json()) as {
    results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> }
  }
  return (json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim()
}

function truncate(s: string): string {
  return s.length > 300 ? s.slice(0, 300) + "..." : s
}
