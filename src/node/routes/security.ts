import { Router } from "express"
import { ensureAuthenticated, ensureOrigin, redirect } from "../http"
import { TEMP_BLOCK_THRESHOLD, PERMANENT_THRESHOLD } from "../ipBan"
import { escapeHtml, sanitizeString } from "../util"

export const router = Router()

/**
 * Minimal management page for login bans.  Only reachable with a valid
 * session, so a locked-out owner uses the magic links from the logs/email
 * instead (see routes/unban.ts).
 */
router.get("/", ensureAuthenticated, async (req, res) => {
  const bans = await req.ipBan.list()
  const entries = Object.entries(bans)

  const rows = entries
    .map(([ip, entry]) => {
      const status = entry.permanent
        ? "permanently banned"
        : entry.blockedUntil && entry.blockedUntil > Date.now()
          ? `blocked until ${new Date(entry.blockedUntil).toISOString()}`
          : `${entry.failures} failure(s)`
      return (
        `<tr><td><code>${escapeHtml(ip)}</code></td><td>${entry.failures}</td><td>${status}</td>` +
        `<td><form method="post" action="./security/unban" style="margin:0">` +
        `<input type="hidden" name="ip" value="${escapeHtml(ip)}" />` +
        `<button type="submit">Unban</button></form></td></tr>`
      )
    })
    .join("")

  res.send(
    [
      "<!doctype html>",
      '<html lang="en"><head><meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      '<meta name="color-scheme" content="light dark" />',
      "<title>Login security</title></head>",
      '<body style="font-family: sans-serif; max-width: 50em; margin: 3em auto; padding: 0 1em;">',
      "<h1>Login security</h1>",
      `<p>Addresses are blocked for 15 minutes after ${TEMP_BLOCK_THRESHOLD} failed logins and banned permanently after ${PERMANENT_THRESHOLD}. ` +
        "Recovery links for locked-out addresses are in the deployment logs (and $OWNER_EMAIL if set).</p>",
      entries.length
        ? `<table border="1" cellpadding="6" style="border-collapse: collapse; width: 100%;">` +
          `<tr><th>Address</th><th>Failures</th><th>Status</th><th></th></tr>${rows}</table>`
        : "<p>No tracked addresses. All clear.</p>",
      "</body></html>",
    ].join(""),
  )
})

router.post("/unban", ensureOrigin, ensureAuthenticated, async (req, res) => {
  const ip = sanitizeString(req.body?.ip)
  if (ip) {
    await req.ipBan.unban(ip)
    req.ipBan.audit("unban", ip, { via: "security-page" })
  }
  redirect(req, res, "security", {})
})
