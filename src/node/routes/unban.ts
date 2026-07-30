import { Router } from "express"
import { getClientIp } from "../ipBan"
import { escapeHtml } from "../util"

export const router = Router()

const page = (title: string, body: string): string => {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '<meta name="color-scheme" content="light dark" />',
    `<title>${title}</title></head>`,
    `<body style="font-family: sans-serif; max-width: 40em; margin: 4em auto; padding: 0 1em;">`,
    `<h1>${title}</h1>${body}`,
    "</body></html>",
  ].join("")
}

/**
 * Single-use recovery links issued when an address gets blocked or banned.
 * The token itself is the authorization: it is only ever written to the
 * server logs and mailed to the owner.
 */
router.get<{}, string, undefined, { token?: string }>("/", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : ""
  const entry = token ? await req.ipBan.consumeToken(token) : undefined

  if (!entry) {
    res.status(403).send(page("Invalid link", "<p>This recovery link is invalid, expired, or already used.</p>"))
    return
  }

  await req.ipBan.unban(entry.ip)
  req.ipBan.audit("unban", entry.ip, { via: "magic-link", requestIp: getClientIp(req) })

  if (entry.action === "reset-2fa") {
    const resetOk = await req.twoFactor.reset()
    req.ipBan.audit("2fa_reset", entry.ip, { ok: resetOk })
    if (resetOk) {
      res.send(
        page(
          "Unbanned & 2FA reset",
          `<p>The address <code>${escapeHtml(entry.ip)}</code> was unbanned and two-factor enrollment was cleared. ` +
            `The next <a href="./login">login</a> will walk through 2FA setup again.</p>`,
        ),
      )
    } else {
      res.send(
        page(
          "Unbanned (2FA unchanged)",
          `<p>The address <code>${escapeHtml(entry.ip)}</code> was unbanned. The 2FA secret comes from ` +
            `<code>$TOTP_SECRET</code> and can only be changed in the deployment environment variables.</p>` +
            `<p><a href="./login">Back to login</a></p>`,
        ),
      )
    }
    return
  }

  res.send(
    page(
      "Unbanned",
      `<p>The address <code>${escapeHtml(entry.ip)}</code> was unbanned. <a href="./login">Back to login</a>.</p>`,
    ),
  )
})
