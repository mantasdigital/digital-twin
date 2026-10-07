/**
 * Server-side speech-to-text. The browser provider needs nothing here (the
 * webview sends finished text); OpenAI and Deepgram receive the recorded clip.
 * Node 22 provides fetch, FormData and Blob globally.
 */

export interface TranscribeOptions {
  provider: "openai" | "deepgram"
  apiKey: string
  audio: Buffer
  mime: string
  language: string
  vocabulary: string[]
  openaiModel: string
  deepgramModel: string
}

export async function transcribe(opts: TranscribeOptions): Promise<string> {
  if (opts.provider === "openai") return transcribeOpenAI(opts)
  return transcribeDeepgram(opts)
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
