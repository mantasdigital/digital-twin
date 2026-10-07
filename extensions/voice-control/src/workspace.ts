import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

export interface TerminalInfo {
  index: number
  name: string
  active: boolean
}

const ORDINALS: Record<string, number> = {
  one: 1,
  first: 1,
  two: 2,
  second: 2,
  three: 3,
  third: 3,
  four: 4,
  fourth: 4,
  five: 5,
  fifth: 5,
  six: 6,
  sixth: 6,
  seven: 7,
  seventh: 7,
  eight: 8,
  eighth: 8,
  nine: 9,
  ninth: 9,
  ten: 10,
  tenth: 10,
}

/**
 * Knows every terminal in the window (ours and the user's) and resolves spoken
 * names like "terminal two", "the build terminal" or "current".
 */
export class TerminalRegistry {
  private readonly recentCommands: string[] = []

  list(): TerminalInfo[] {
    const active = vscode.window.activeTerminal
    return vscode.window.terminals.map((t, i) => ({ index: i + 1, name: t.name, active: t === active }))
  }

  find(spoken: string | undefined): vscode.Terminal | undefined {
    const terminals = vscode.window.terminals
    const query = (spoken || "").trim().toLowerCase()
    if (!query || /^(active|current|this|focused)( terminal)?$/.test(query)) {
      return vscode.window.activeTerminal ?? terminals[terminals.length - 1]
    }
    const exact = terminals.find((t) => t.name.toLowerCase() === query)
    if (exact) return exact
    const stripped = query
      .replace(/^(the\s+)?/, "")
      .replace(/\s+terminal$/, "")
      .trim()
    const byIncludes = terminals.find((t) => t.name.toLowerCase().includes(stripped) && stripped.length > 0)
    if (byIncludes) return byIncludes
    const numberMatch = query.match(/(?:terminal\s*)?(?:number\s*)?(\d+|[a-z]+)$/)
    if (numberMatch) {
      const token = numberMatch[1]
      const n = /^\d+$/.test(token) ? parseInt(token, 10) : ORDINALS[token]
      if (n && terminals[n - 1]) return terminals[n - 1]
    }
    return undefined
  }

  create(name?: string, cwd?: string): vscode.Terminal {
    const terminal = vscode.window.createTerminal({
      name: name && name.trim() ? name.trim() : this.nextName(),
      cwd: cwd || workspaceRoot(),
    })
    terminal.show(false)
    return terminal
  }

  findOrCreate(name: string, cwd?: string): { terminal: vscode.Terminal; created: boolean } {
    const existing = this.find(name)
    if (existing) return { terminal: existing, created: false }
    return { terminal: this.create(name, cwd), created: true }
  }

  nextName(): string {
    const taken = new Set(vscode.window.terminals.map((t) => t.name.toLowerCase()))
    let n = vscode.window.terminals.length + 1
    while (taken.has(`terminal ${n}`)) n++
    return `Terminal ${n}`
  }

  remember(command: string): void {
    this.recentCommands.unshift(command)
    if (this.recentCommands.length > 12) this.recentCommands.length = 12
  }

  recent(): string[] {
    return [...this.recentCommands]
  }
}

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  "coverage",
  ".cache",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".gitnexus",
])

let treeCache: { at: number; root: string | undefined; entries: string[] } | undefined

/**
 * Relative paths of folders (depth 3) and top-level files for the first
 * workspace folder plus ~/workspace siblings, so Claude can map spoken names
 * onto real paths. Cached for 20 seconds.
 */
export async function snapshotTree(): Promise<string[]> {
  const root = workspaceRoot()
  if (treeCache && treeCache.root === root && Date.now() - treeCache.at < 20_000) return treeCache.entries
  const entries: string[] = []
  if (root) {
    await walk(root, root, 0, 3, entries, 400)
  }
  // Also list sibling projects in ~/workspace so "open project xyz" works.
  const ws = path.join(os.homedir(), "workspace")
  if (ws !== root && fs.existsSync(ws)) {
    try {
      for (const d of await fs.promises.readdir(ws, { withFileTypes: true })) {
        if (d.isDirectory() && !d.name.startsWith(".") && !SKIP_DIRS.has(d.name)) entries.push(`~/workspace/${d.name}/`)
      }
    } catch {
      // ignore
    }
  }
  treeCache = { at: Date.now(), root, entries }
  return entries
}

async function walk(root: string, dir: string, depth: number, maxDepth: number, out: string[], cap: number) {
  if (out.length >= cap) return
  let dirents: fs.Dirent[]
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  dirents.sort((a, b) => a.name.localeCompare(b.name))
  for (const d of dirents) {
    if (out.length >= cap) return
    if (d.name.startsWith(".") && depth > 0) continue
    const rel = path.relative(root, path.join(dir, d.name))
    if (d.isDirectory()) {
      if (SKIP_DIRS.has(d.name)) continue
      out.push(rel + "/")
      if (depth + 1 < maxDepth) await walk(root, path.join(dir, d.name), depth + 1, maxDepth, out, cap)
    } else if (depth === 0) {
      out.push(rel)
    }
  }
}

export interface ResolvedPath {
  path: string
  exists: boolean
}

/**
 * Turn whatever Claude produced (relative, absolute, ~-prefixed, or just a
 * folder name) into an absolute path, preferring things that exist.
 */
export function resolvePath(input: string, tree: string[]): ResolvedPath {
  const root = workspaceRoot() || os.homedir()
  let candidate = (input || "").trim().replace(/\\/g, "/")
  if (!candidate || candidate === "." || /^(workspace|root|project|here)$/i.test(candidate)) {
    return { path: root, exists: fs.existsSync(root) }
  }
  if (candidate.startsWith("~/")) candidate = path.join(os.homedir(), candidate.slice(2))
  else if (candidate === "~") candidate = os.homedir()
  const direct = path.isAbsolute(candidate) ? candidate : path.join(root, candidate)
  if (fs.existsSync(direct)) return { path: direct, exists: true }

  // Fuzzy: match by trailing path segment(s) against the indexed tree, case-insensitively.
  const wanted = candidate.replace(/\/+$/, "").toLowerCase()
  const wantedBase = path.basename(wanted)
  const scored = tree
    .map((entry) => {
      const clean = entry.replace(/\/+$/, "")
      const abs = clean.startsWith("~/") ? path.join(os.homedir(), clean.slice(2)) : path.join(root, clean)
      const lower = clean.toLowerCase()
      let score = 0
      if (lower === wanted || lower.endsWith("/" + wanted)) score = 3
      else if (path.basename(lower) === wantedBase) score = 2
      else if (path.basename(lower).replace(/[-_ ]/g, "") === wantedBase.replace(/[-_ ]/g, "")) score = 1
      return { abs, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
  if (scored.length) return { path: scored[0].abs, exists: fs.existsSync(scored[0].abs) }
  return { path: direct, exists: false }
}

export function buildContext(registry: TerminalRegistry, tree: string[]): string {
  const root = workspaceRoot()
  const terminals = registry.list()
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath
  const lines: string[] = []
  lines.push(`workspace_root: ${root ?? "(no folder open)"}`)
  lines.push(`home: ${os.homedir()}`)
  lines.push(`date: ${new Date().toISOString().slice(0, 10)}`)
  if (activeFile) lines.push(`active_file: ${root ? path.relative(root, activeFile) : activeFile}`)
  lines.push("")
  lines.push("terminals (index: name):")
  if (!terminals.length) lines.push("  (none open)")
  for (const t of terminals) lines.push(`  ${t.index}: ${t.name}${t.active ? "  <- active" : ""}`)
  const recent = registry.recent()
  if (recent.length) {
    lines.push("")
    lines.push("recent_commands:")
    for (const c of recent.slice(0, 8)) lines.push(`  ${c}`)
  }
  lines.push("")
  lines.push(`folders_and_files (relative to workspace_root, depth 3, ${tree.length} entries):`)
  for (const e of tree.slice(0, 300)) lines.push(`  ${e}`)
  if (tree.length > 300) lines.push(`  ... (${tree.length - 300} more)`)
  return lines.join("\n")
}

/** Words a speech engine is likely to mishear; passed as hints to the STT provider. */
export function vocabulary(registry: TerminalRegistry, tree: string[]): string[] {
  const words = new Set<string>([
    "terminal",
    "workspace",
    "Claude",
    "Claude Code",
    "npm",
    "pnpm",
    "yarn",
    "git",
    "sudo",
    "curl",
    "docker",
    "Railway",
    "GitHub",
    "localhost",
    "config",
    "src",
  ])
  for (const t of registry.list()) words.add(t.name)
  for (const e of tree.slice(0, 120)) {
    const base = path.basename(e.replace(/\/+$/, ""))
    if (base && base.length > 2 && base.length < 30) words.add(base)
  }
  return Array.from(words).slice(0, 100)
}
