import Anthropic from "@anthropic-ai/sdk"
import { execFile } from "child_process"
import * as os from "os"

export interface Action {
  tool: string
  input: Record<string, any>
}

export interface IntentResult {
  actions: Action[]
  say?: string
  refused?: boolean
}

/**
 * Every property is listed in `required` (strict mode); "not specified" is an
 * empty string / false / 0 so the schema stays simple and validation stays exact.
 */
export const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  tool(
    "open_terminal",
    "Open a new terminal. Optionally give it a name, a working directory and a first command to run.",
    {
      name: str("Spoken name for the terminal, e.g. 'build' or 'server'. Empty string for an automatic name."),
      cwd: str(
        "Folder to start in, relative to workspace_root or absolute or ~/... Empty string for the workspace root.",
      ),
      command: str("Command to run right after opening. Empty string for none."),
    },
  ),
  tool("focus_terminal", "Bring an existing terminal to the front and give it keyboard focus.", {
    name: str("Terminal name, or 'terminal 2' / 'second terminal', or 'active'."),
  }),
  tool(
    "run_in_terminal",
    "Type a shell command into a terminal. execute=true presses Enter, execute=false only types it so the user can review or finish it.",
    {
      terminal: str("Target terminal name / 'terminal 2' / empty string for the active terminal."),
      command: str("The exact shell command."),
      execute: bool("true to run it immediately; false to only type it."),
    },
  ),
  tool("close_terminal", "Close (kill) a terminal.", { name: str("Terminal name / 'terminal 2' / 'active'.") }),
  tool(
    "type_text",
    "Dictation: insert cleaned-up text where the user is working without executing anything. Use when the user is dictating prose, a commit message, a prompt, code, etc.",
    {
      text: str("The text to insert, already cleaned of filler words and with spoken punctuation converted."),
      target: enm(
        ["terminal", "editor"],
        "Where to insert: the active terminal (no Enter) or the active text editor at the cursor.",
      ),
    },
  ),
  tool(
    "open_folder",
    "Switch the IDE workspace to a different folder (this reloads the window). Only for 'open project X' / 'switch to folder X'. To just show a folder, use reveal_in_explorer.",
    {
      path: str("Folder path: relative to workspace_root, absolute, or ~/workspace/<project>."),
      new_window: bool("true to open in a new browser window instead of replacing the current workspace."),
    },
  ),
  tool("reveal_in_explorer", "Show a folder or file in the Explorer side bar (expands and selects it).", {
    path: str("Path relative to workspace_root, or absolute."),
  }),
  tool("open_file", "Open a file in the editor.", {
    path: str("File path relative to workspace_root, or absolute."),
    line: int("1-based line to jump to, or 0 for none."),
  }),
  tool("download", "Download a URL into a folder using curl in a visible terminal so progress is shown.", {
    url: str("The URL to download."),
    dest_dir: str(
      "Destination folder (relative to workspace_root, absolute or ~/...). Empty string for the workspace root.",
    ),
    filename: str("File name to save as. Empty string to use the name from the URL."),
  }),
  tool(
    "run_vscode_command",
    "Run a VS Code command by id, e.g. workbench.action.togglePanel, workbench.action.files.saveAll, workbench.action.terminal.split, editor.action.formatDocument.",
    {
      command: str("The VS Code command id."),
      args_json: str("JSON array of arguments, or empty string for none."),
    },
  ),
  tool(
    "ask_claude_code",
    "Hand a coding or research task to Claude Code, the AI agent running in a terminal: fixing bugs, writing or explaining code, refactoring, anything that needs reasoning over the codebase. Also whenever the user says 'ask claude', 'tell claude' or 'have claude ...'.",
    {
      prompt: str("The full request for Claude Code, written clearly in one line."),
      terminal: str("Terminal that is running Claude Code, or empty string to use/create one named 'Claude'."),
    },
  ),
  tool(
    "say",
    "Speak a short reply to the user: confirm what you did, ask a clarifying question when a request is ambiguous or refers to something that does not exist, or answer a quick question. Keep it under 15 words.",
    { message: str("What to say.") },
  ),
]

function tool(name: string, description: string, properties: Record<string, object>): Anthropic.Beta.BetaTool {
  return {
    name,
    description,
    strict: true,
    input_schema: {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  }
}
function str(description: string) {
  return { type: "string", description }
}
function bool(description: string) {
  return { type: "boolean", description }
}
function int(description: string) {
  return { type: "integer", description }
}
function enm(values: string[], description: string) {
  return { type: "string", enum: values, description }
}

const SYSTEM = `You are the voice-control brain of "Digital Twin", a browser-based VS Code (code-server) with Claude Code installed, running on the user's own Linux server. The user talks; a speech engine transcribes; you turn the transcript into tool calls that the IDE executes immediately.

How to behave:
- Prefer acting over talking. Call one or more tools in the order they should happen. Add a short "say" only when useful (a question, a quick answer, or when nothing can be done).
- The transcript is speech: expect missing punctuation, mis-heard technical words, and spoken forms. Interpret generously: "open terminal in source slash node" -> open_terminal cwd "src/node"; "run npm test in terminal two" -> run_in_terminal terminal "terminal 2"; "dash dash force" -> "--force"; "dot env" -> ".env"; "new line" in dictation -> a line break.
- Use the <context> block as ground truth for terminal names and existing folders/files. Map spoken names onto the closest real path. If the user names a folder that does not exist and clearly wants it to exist, create it as part of the command (mkdir -p). If it is ambiguous, ask with "say" instead of guessing.
- "the terminal" / no terminal named -> the active terminal. "new terminal" -> open_terminal.
- Dictation: if the user is clearly dictating text rather than commanding ("type ...", "write ...", or speaks prose/a prompt after mentioning the editor or Claude), use type_text with cleaned text (remove fillers like um/uh, keep meaning, apply spoken punctuation). Do not execute dictation.
- Coding tasks, explanations, multi-file edits, "ask claude ...": use ask_claude_code with a crisp one-line prompt. For "ask claude" with the terminal running Claude Code already open, send the prompt there.
- Downloads: use the download tool (never type raw curl yourself).
- Shell commands you emit are run as the user's shell on Linux (bash). Never emit commands that are not what the user asked for. Never add sudo unless the user said so.
- Keep "say" replies very short and natural, suitable for text-to-speech. No markdown.
- If the transcript is empty, noise, or just a greeting, reply with a brief "say".`

export interface InterpretOptions {
  apiKey: string
  model: string
  transcript: string
  context: string
  signal?: AbortSignal
}

export async function interpret(opts: InterpretOptions): Promise<IntentResult> {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 1, timeout: 60_000 })
  const content = `<context>\n${opts.context}\n</context>\n\n<transcript>\n${opts.transcript}\n</transcript>`

  const base = {
    model: opts.model,
    max_tokens: 2048,
    output_config: { effort: "low" as const },
    system: [{ type: "text" as const, text: SYSTEM, cache_control: { type: "ephemeral" as const } }],
    tools: TOOLS,
    messages: [{ role: "user" as const, content }],
  }

  let response: Anthropic.Beta.BetaMessage
  try {
    // Server-side fallback: if a safety classifier declines, the API re-runs the
    // request on a fallback model inside the same call.
    response = await client.beta.messages.create(
      { ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
      { signal: opts.signal },
    )
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) {
      response = await client.beta.messages.create(base, { signal: opts.signal })
    } else {
      throw err
    }
  }

  if (response.stop_reason === "refusal") {
    return { actions: [], say: "I can't help with that one.", refused: true }
  }

  const actions: Action[] = []
  const texts: string[] = []
  let say: string | undefined
  for (const block of response.content) {
    if (block.type === "tool_use") {
      const input = (block.input ?? {}) as Record<string, any>
      if (block.name === "say") {
        say = [say, String(input.message ?? "")].filter(Boolean).join(" ")
      } else {
        actions.push({ tool: block.name, input })
      }
    } else if (block.type === "text" && block.text.trim()) {
      texts.push(block.text.trim())
    }
  }
  if (!say && texts.length) say = texts.join(" ").slice(0, 300)
  if (!actions.length && !say) say = "Sorry, I didn't catch that."
  return { actions, say }
}

// ---------------------------------------------------------------------------
// Claude account path: run Claude Code headless. It uses the same login as the
// `claude` terminal command, so no API key is needed. All tools are disabled
// and the answer is constrained to a JSON schema; we execute the actions.
// ---------------------------------------------------------------------------

const TOOL_NAMES = new Set(TOOLS.map((t) => (t as Anthropic.Beta.BetaTool).name))

function toolCatalog(): string {
  return TOOLS.map((t) => {
    const tool = t as Anthropic.Beta.BetaTool
    const props = (tool.input_schema as any).properties as Record<
      string,
      { description?: string; enum?: string[]; type?: string }
    >
    const inputs = Object.entries(props)
      .map(([k, v]) => `${k} (${v.type}${v.enum ? ": " + v.enum.join("|") : ""}) - ${v.description ?? ""}`)
      .join("; ")
    return `- ${tool.name}: ${tool.description}\n    inputs: ${inputs}`
  }).join("\n")
}

const CLAUDE_CODE_SCHEMA = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: { tool: { type: "string" }, input: { type: "object" } },
        required: ["tool", "input"],
      },
    },
    say: { type: "string" },
  },
  required: ["actions", "say"],
}

function modelAlias(model: string): string {
  if (/haiku/.test(model)) return "haiku"
  if (/sonnet/.test(model)) return "sonnet"
  if (/opus/.test(model)) return "opus"
  return model
}

export interface ClaudeCodeOptions {
  claudePath: string
  model: string
  transcript: string
  context: string
  signal?: AbortSignal
}

export async function interpretViaClaudeCode(opts: ClaudeCodeOptions): Promise<IntentResult> {
  const system =
    SYSTEM +
    '\n\nYou answer ONLY with JSON matching the schema: {"actions": [{"tool", "input"}...], "say": string}. ' +
    'Put IDE actions in "actions" in the order they should run, with every input field present (use "", false or 0 when not applicable). ' +
    'Put anything to tell the user in "say" (empty string if nothing). Never put "say" inside actions.\n\nAvailable actions:\n' +
    toolCatalog()
  const prompt = `<context>\n${opts.context}\n</context>\n\n<transcript>\n${opts.transcript}\n</transcript>`
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(CLAUDE_CODE_SCHEMA),
    "--tools",
    "",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--max-turns",
    "1",
    "--model",
    modelAlias(opts.model),
    "--system-prompt",
    system,
  ]
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      opts.claudePath,
      args,
      {
        cwd: os.tmpdir(),
        timeout: 90_000,
        maxBuffer: 8 * 1024 * 1024,
        signal: opts.signal,
        env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      },
      (err, out, errOut) => {
        if (err && !out) reject(new Error(`Claude Code failed: ${(errOut || err.message).toString().slice(0, 300)}`))
        else resolve(out.toString())
      },
    )
  })
  let envelope: any
  try {
    envelope = JSON.parse(stdout)
  } catch {
    throw new Error(`Claude Code returned unexpected output: ${stdout.slice(0, 200)}`)
  }
  if (envelope.is_error) {
    const msg = String(envelope.result || "unknown error")
    if (/log ?in|auth|credential|token/i.test(msg))
      throw new Error("Claude Code is not logged in. Run `claude` in a terminal and sign in, or add an API key.")
    throw new Error(`Claude Code: ${msg.slice(0, 300)}`)
  }
  let parsed: any = envelope.structured_output
  if (!parsed && typeof envelope.result === "string") {
    try {
      parsed = JSON.parse(envelope.result)
    } catch {
      return { actions: [], say: envelope.result.slice(0, 300) }
    }
  }
  const actions: Action[] = []
  for (const raw of Array.isArray(parsed?.actions) ? parsed.actions : []) {
    if (!raw || typeof raw.tool !== "string") continue
    if (raw.tool === "say") continue
    if (!TOOL_NAMES.has(raw.tool)) continue
    actions.push({ tool: raw.tool, input: fillDefaults(raw.tool, raw.input) })
  }
  const say = typeof parsed?.say === "string" && parsed.say.trim() ? parsed.say.trim().slice(0, 300) : undefined
  if (!actions.length && !say) return { actions: [], say: "Sorry, I didn't catch that." }
  return { actions, say }
}

/** Make a loosely-typed input match the strict schema the executor expects. */
function fillDefaults(toolName: string, input: unknown): Record<string, any> {
  const tool = TOOLS.find((t) => (t as Anthropic.Beta.BetaTool).name === toolName) as
    | Anthropic.Beta.BetaTool
    | undefined
  const props = ((tool?.input_schema as any)?.properties ?? {}) as Record<string, { type?: string }>
  const src = (input && typeof input === "object" ? input : {}) as Record<string, any>
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(props)) {
    const val = src[k]
    if (v.type === "boolean") out[k] = typeof val === "boolean" ? val : String(val).toLowerCase() === "true"
    else if (v.type === "integer") out[k] = Number.isFinite(Number(val)) ? Math.trunc(Number(val)) : 0
    else out[k] = val === undefined || val === null ? "" : String(val)
  }
  return out
}
