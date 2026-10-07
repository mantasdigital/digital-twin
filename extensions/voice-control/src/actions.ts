import * as path from "path"
import * as vscode from "vscode"
import { Action } from "./intent"
import { resolvePath, TerminalRegistry, workspaceRoot } from "./workspace"

export interface ExecContext {
  registry: TerminalRegistry
  tree: string[]
}

const DANGEROUS_SHELL = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r|-rf|--recursive)\b/i,
  /\bsudo\b/,
  /\bgit\s+push\b.*(--force|-f\b|\+)/,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D)/,
  /\bmkfs\b|\bdd\s+if=|\bfdisk\b|\bparted\b/,
  />\s*\/dev\/(sd|nvme|null\s*2>&1\s*;?\s*rm)/,
  /\bchmod\s+(-R\s+)?777\b|\bchown\s+-R\b/,
  /\bkill(all)?\s+-9\b|\bpkill\b|\bshutdown\b|\breboot\b|\bhalt\b/,
  /\bdrop\s+(table|database)\b|\btruncate\s+table\b/i,
  /\bdocker\s+(system\s+prune|rm\s+-f|rmi)\b/,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bcurl\b[^|]*\|\s*(ba)?sh\b|\bwget\b[^|]*\|\s*(ba)?sh\b/,
]

const DANGEROUS_VSCODE = /close|quit|delete|trash|discard|revert|uninstall|reset/i

export function isDangerous(action: Action): boolean {
  switch (action.tool) {
    case "run_in_terminal":
      return action.input.execute !== false && DANGEROUS_SHELL.some((re) => re.test(String(action.input.command ?? "")))
    case "open_terminal":
      return DANGEROUS_SHELL.some((re) => re.test(String(action.input.command ?? "")))
    case "run_vscode_command":
      return DANGEROUS_VSCODE.test(String(action.input.command ?? ""))
    case "close_terminal":
      return false
    default:
      return false
  }
}

export function describe(action: Action): string {
  const i = action.input
  switch (action.tool) {
    case "open_terminal":
      return `Open terminal${i.name ? ` "${i.name}"` : ""}${i.cwd ? ` in ${i.cwd}` : ""}${i.command ? ` and run: ${i.command}` : ""}`
    case "focus_terminal":
      return `Focus terminal "${i.name}"`
    case "run_in_terminal":
      return `${i.execute === false ? "Type" : "Run"} in ${i.terminal ? `"${i.terminal}"` : "active terminal"}: ${i.command}`
    case "close_terminal":
      return `Close terminal "${i.name}"`
    case "type_text":
      return `Insert text into ${i.target}: "${String(i.text).slice(0, 80)}"`
    case "open_folder":
      return `Open folder ${i.path}${i.new_window ? " in a new window" : " (reloads window)"}`
    case "reveal_in_explorer":
      return `Reveal ${i.path} in Explorer`
    case "open_file":
      return `Open file ${i.path}${i.line ? `:${i.line}` : ""}`
    case "download":
      return `Download ${i.url} -> ${i.dest_dir || "workspace"}${i.filename ? `/${i.filename}` : ""}`
    case "run_vscode_command":
      return `VS Code command: ${i.command}`
    case "ask_claude_code":
      return `Ask Claude Code: ${String(i.prompt).slice(0, 100)}`
    default:
      return `${action.tool} ${JSON.stringify(i)}`
  }
}

/** Single-quote for bash. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function execute(action: Action, ctx: ExecContext): Promise<string> {
  const i = action.input
  switch (action.tool) {
    case "open_terminal": {
      let cwd: string | undefined
      if (i.cwd) {
        const r = resolvePath(String(i.cwd), ctx.tree)
        if (!r.exists) {
          // Create it so "open a terminal in a new folder called x" works.
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(r.path))
        }
        cwd = r.path
      }
      const term = ctx.registry.create(String(i.name || ""), cwd)
      if (i.command) {
        term.sendText(String(i.command), true)
        ctx.registry.remember(String(i.command))
      }
      return `Opened terminal "${term.name}"`
    }
    case "focus_terminal": {
      const term = ctx.registry.find(String(i.name))
      if (!term) return `No terminal called "${i.name}"`
      term.show(false)
      return `Focused "${term.name}"`
    }
    case "run_in_terminal": {
      let term = ctx.registry.find(String(i.terminal || ""))
      if (!term) {
        if (i.terminal) return `No terminal called "${i.terminal}"`
        term = ctx.registry.create()
      }
      term.show(true)
      const execute = i.execute !== false
      term.sendText(String(i.command), execute)
      if (execute) ctx.registry.remember(String(i.command))
      return `${execute ? "Ran" : "Typed"} in "${term.name}": ${i.command}`
    }
    case "close_terminal": {
      const term = ctx.registry.find(String(i.name))
      if (!term) return `No terminal called "${i.name}"`
      const name = term.name
      term.dispose()
      return `Closed "${name}"`
    }
    case "type_text": {
      const text = String(i.text ?? "")
      if (i.target === "editor") {
        const editor = vscode.window.activeTextEditor
        if (!editor) return "No editor is open"
        await editor.edit((b) => {
          for (const sel of editor.selections) b.replace(sel, text)
        })
        return "Inserted text into the editor"
      }
      const term = vscode.window.activeTerminal ?? ctx.registry.create()
      term.show(true)
      term.sendText(text, false)
      return `Typed into "${term.name}"`
    }
    case "open_folder": {
      const r = resolvePath(String(i.path), ctx.tree)
      if (!r.exists) return `Folder not found: ${i.path}`
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(r.path), {
        forceNewWindow: Boolean(i.new_window),
      })
      return `Opening ${r.path}`
    }
    case "reveal_in_explorer": {
      const r = resolvePath(String(i.path), ctx.tree)
      if (!r.exists) return `Not found: ${i.path}`
      await vscode.commands.executeCommand("workbench.view.explorer")
      await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(r.path))
      return `Revealed ${path.basename(r.path)}`
    }
    case "open_file": {
      const r = resolvePath(String(i.path), ctx.tree)
      if (!r.exists) return `File not found: ${i.path}`
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(r.path))
      const line = Math.max(0, Number(i.line || 0) - 1)
      const pos = new vscode.Position(line, 0)
      await vscode.window.showTextDocument(doc, { selection: i.line ? new vscode.Range(pos, pos) : undefined })
      return `Opened ${path.basename(r.path)}`
    }
    case "download": {
      const url = String(i.url ?? "").trim()
      if (!/^https?:\/\//i.test(url)) return `Not a web URL: ${url}`
      const dest = resolvePath(String(i.dest_dir || ""), ctx.tree)
      let filename = String(i.filename || "").trim()
      if (!filename) {
        try {
          filename = path.basename(new URL(url).pathname) || "download"
        } catch {
          filename = "download"
        }
      }
      const target = path.join(dest.path, filename)
      const { terminal } = ctx.registry.findOrCreate("Downloads", workspaceRoot())
      terminal.show(true)
      const cmd = `curl -fL --create-dirs -o ${sq(target)} ${sq(url)}`
      terminal.sendText(cmd, true)
      ctx.registry.remember(cmd)
      return `Downloading to ${target}`
    }
    case "run_vscode_command": {
      let args: unknown[] = []
      if (i.args_json) {
        try {
          const parsed = JSON.parse(String(i.args_json))
          args = Array.isArray(parsed) ? parsed : [parsed]
        } catch {
          return `Invalid arguments for ${i.command}`
        }
      }
      await vscode.commands.executeCommand(String(i.command), ...args)
      return `Ran ${i.command}`
    }
    case "ask_claude_code": {
      const prompt = String(i.prompt ?? "")
        .replace(/\s*\n\s*/g, " ")
        .trim()
      let term = i.terminal ? ctx.registry.find(String(i.terminal)) : undefined
      if (!term) term = vscode.window.terminals.find((t) => /claude/i.test(t.name))
      let created = false
      if (!term) {
        term = ctx.registry.create("Claude", workspaceRoot())
        term.sendText("claude", true)
        created = true
      }
      term.show(false)
      if (created) await sleep(6000) // let Claude Code start before the prompt arrives
      term.sendText(prompt, true)
      return `Sent to Claude Code: ${prompt.slice(0, 80)}`
    }
    default:
      return `Unknown action ${action.tool}`
  }
}
