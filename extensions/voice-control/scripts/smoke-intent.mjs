// Exercise the intent layer without VS Code.
//   API key:        ANTHROPIC_API_KEY=sk-ant-... node scripts/smoke-intent.mjs "open a terminal in src"
//   Claude account: node scripts/smoke-intent.mjs --claude "open a terminal in src"   (uses the `claude` login)
import * as esbuild from "esbuild"
import { createRequire } from "node:module"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(os.tmpdir(), `dtv-intent-${process.pid}.cjs`)
await esbuild.build({
  entryPoints: [path.join(here, "..", "src", "intent.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  logLevel: "silent",
})
const { interpret, interpretViaClaudeCode } = createRequire(import.meta.url)(out)

const argv = process.argv.slice(2)
const useClaude = argv.includes("--claude")
const transcript =
  argv.filter((a) => a !== "--claude").join(" ") ||
  "open a new terminal called server in src slash node and run npm start"
const context = [
  "workspace_root: /home/digital-twin/workspace/digital-twin",
  "home: /home/digital-twin",
  "",
  "terminals (index: name):",
  "  1: bash  <- active",
  "  2: Claude",
  "",
  "folders_and_files (relative to workspace_root):",
  "  ci/",
  "  src/",
  "  src/node/",
  "  src/browser/",
  "  test/",
  "  package.json",
  "  README.md",
].join("\n")

const started = Date.now()
const model = process.env.DTV_MODEL || (useClaude ? "claude-haiku-5-5" : "claude-opus-5-5")
const result = useClaude
  ? await interpretViaClaudeCode({ claudePath: process.env.CLAUDE_BIN || "claude", model, transcript, context })
  : await interpret({ apiKey: process.env.ANTHROPIC_API_KEY, model, transcript, context })
console.log(JSON.stringify(result, null, 2))
console.log(`(${Date.now() - started} ms, ${useClaude ? "claude account" : "api key"}, ${model})`)
