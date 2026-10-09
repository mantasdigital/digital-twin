#!/usr/bin/env node
// Merge safe defaults into the user's code-server settings.json (JSONC tolerated).
// Only keys that are absent are added; the user's own values always win.
//
// Why: VS Code watches the opened folder recursively, one inotify watch per
// directory. A workspace with many projects reaches hundreds of thousands of
// watches, and Railway stops the container ("Too many file watchers in use").
// Excluding build output, caches and dependency trees keeps the count small.
const fs = require("fs")
const path = require("path")

const dataHome = process.env.XDG_DATA_HOME || path.join(process.env.HOME || "/home/digital-twin", ".local", "share")
const file = process.argv[2] || path.join(dataHome, "code-server", "User", "settings.json")

const DEFAULTS = {
  "files.watcherExclude": {
    "**/.git/objects/**": true,
    "**/.git/subtree-cache/**": true,
    "**/.git/**": true,
    "**/node_modules/**": true,
    "**/.pnpm/**": true,
    "**/.yarn/**": true,
    "**/bower_components/**": true,
    "**/vendor/**": true,
    "**/dist/**": true,
    "**/build/**": true,
    "**/out/**": true,
    "**/.next/**": true,
    "**/.nuxt/**": true,
    "**/.turbo/**": true,
    "**/.cache/**": true,
    "**/.parcel-cache/**": true,
    "**/coverage/**": true,
    "**/.venv/**": true,
    "**/venv/**": true,
    "**/__pycache__/**": true,
    "**/.pytest_cache/**": true,
    "**/.mypy_cache/**": true,
    "**/target/**": true,
    "**/.gradle/**": true,
    "**/tmp/**": true,
    "**/temp/**": true,
    "**/logs/**": true,
    "**/*.log": true,
    "**/.gitnexus/**": true,
    "**/.ephemeral-home-backup-*/**": true,
  },
  "search.followSymlinks": false,
  "files.autoSave": "afterDelay",
}

function stripJsonc(text) {
  // remove /* */ and // comments outside strings, and trailing commas
  let out = ""
  let i = 0
  let inStr = false
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (inStr) {
      out += ch
      if (ch === "\\") {
        out += next
        i += 2
        continue
      }
      if (ch === '"') inStr = false
      i++
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
      i++
      continue
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out.replace(/,\s*([}\]])/g, "$1")
}

let current = {}
let raw = ""
try {
  raw = fs.readFileSync(file, "utf8")
  current = JSON.parse(stripJsonc(raw))
} catch (err) {
  if (raw.trim()) {
    console.log(`ensure-vscode-settings: could not parse ${file}; leaving it untouched (${err.message})`)
    process.exit(0)
  }
}

let changed = false
for (const [key, value] of Object.entries(DEFAULTS)) {
  if (!(key in current)) {
    current[key] = value
    changed = true
  } else if (key === "files.watcherExclude" && typeof current[key] === "object") {
    // keep the user's entries, add ours where missing
    for (const [pattern, on] of Object.entries(value)) {
      if (!(pattern in current[key])) {
        current[key][pattern] = on
        changed = true
      }
    }
  }
}
if (changed) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n")
  console.log(`ensure-vscode-settings: updated ${file}`)
} else {
  console.log("ensure-vscode-settings: nothing to add")
}
