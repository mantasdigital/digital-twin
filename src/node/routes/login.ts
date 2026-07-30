import { logger } from "@coder/logger"
import { Router, Request } from "express"
import { promises as fs } from "fs"
import { RateLimiter as Limiter } from "limiter"
import * as path from "path"
import * as qrcode from "qrcode"
import { rootPath } from "../constants"
import { authenticated, getCookieOptions, getHost, redirect, replaceTemplates } from "../http"
import i18n from "../i18n"
import { getClientIp } from "../ipBan"
import { sendMail } from "../mailer"
import { issueSessionToken, totpUri } from "../twoFactor"
import { getPasswordMethod, handlePasswordValidation, sanitizeString, escapeHtml } from "../util"

// RateLimiter wraps around the limiter library for logins.
// It allows 2 logins every minute plus 12 logins every hour.
export class RateLimiter {
  private readonly minuteLimiter = new Limiter({ tokensPerInterval: 2, interval: "minute" })
  private readonly hourLimiter = new Limiter({ tokensPerInterval: 12, interval: "hour" })

  public canTry(): boolean {
    // Note: we must check using >= 1 because technically when there are no tokens left
    // you get back a number like 0.00013333333333333334
    // which would cause fail if the logic were > 0
    return this.minuteLimiter.getTokensRemaining() >= 1 || this.hourLimiter.getTokensRemaining() >= 1
  }

  public removeToken(): boolean {
    return this.minuteLimiter.tryRemoveTokens(1) || this.hourLimiter.tryRemoveTokens(1)
  }
}

const getRoot = async (req: Request, error?: Error): Promise<string> => {
  const content = await fs.readFile(path.join(rootPath, "src/browser/pages/login.html"), "utf8")
  const locale = req.args["locale"] || "en"
  i18n.changeLanguage(locale)
  const appName = req.args["app-name"] || "code-server"
  const welcomeText = req.args["welcome-text"] || (i18n.t("WELCOME", { app: appName }) as string)

  // Determine password message using i18n
  let passwordMsg = i18n.t("LOGIN_PASSWORD", { configFile: req.args.config })
  if (req.args.usingEnvPassword) {
    passwordMsg = i18n.t("LOGIN_USING_ENV_PASSWORD")
  } else if (req.args.usingEnvHashedPassword) {
    passwordMsg = i18n.t("LOGIN_USING_HASHED_PASSWORD")
  }

  const passwordField = `<input required autofocus class="password" type="password" placeholder="${i18n.t(
    "PASSWORD_PLACEHOLDER",
  )}" name="password" autocomplete="current-password" />`
  const submitButton = `<input class="submit -button" value="${i18n.t("SUBMIT")}" type="submit" />`
  // With two-factor enrolled the form asks for the code alongside the
  // password.  autocomplete="one-time-code" lets 1Password and browsers
  // autofill it.
  const totpField = `<input required class="password" type="text" placeholder="${i18n.t(
    "TOTP_PLACEHOLDER",
  )}" name="code" autocomplete="one-time-code" inputmode="numeric" maxlength="8" />`
  const loginFields = (await req.twoFactor.isEnrolled())
    ? `<div class="field">${passwordField}</div><div class="field">${totpField}${submitButton}</div>`
    : `<div class="field">${passwordField}${submitButton}</div>`

  return replaceTemplates(
    req,
    content
      .replace(/{{I18N_LOGIN_TITLE}}/g, i18n.t("LOGIN_TITLE", { app: appName }))
      .replace(/{{WELCOME_TEXT}}/g, welcomeText)
      .replace(/{{PASSWORD_MSG}}/g, passwordMsg)
      .replace(/{{I18N_LOGIN_BELOW}}/g, i18n.t("LOGIN_BELOW"))
      .replace("{{LOGIN_FIELDS}}", () => loginFields)
      .replace(/{{ERROR}}/, error ? `<div class="error">${escapeHtml(error.message)}</div>` : ""),
  )
}

const getSetupRoot = async (req: Request, setupToken: string, secret: string, error?: Error): Promise<string> => {
  const content = await fs.readFile(path.join(rootPath, "src/browser/pages/two-factor-setup.html"), "utf8")
  const locale = req.args["locale"] || "en"
  i18n.changeLanguage(locale)
  const appName = req.args["app-name"] || "Digital Twin"
  const account = getHost(req) || "digital-twin"
  const uri = totpUri(secret, account, appName)
  const qrDataUri = await qrcode.toDataURL(uri, { margin: 1, width: 220 })

  return replaceTemplates(
    req,
    content
      .replace(/{{I18N_SETUP_TITLE}}/g, i18n.t("TOTP_SETUP_TITLE"))
      .replace(/{{I18N_SETUP_INTRO}}/g, i18n.t("TOTP_SETUP_INTRO"))
      .replace(/{{I18N_SETUP_SECRET_LABEL}}/g, i18n.t("TOTP_SETUP_SECRET_LABEL"))
      .replace(/{{I18N_SETUP_ENV_NOTE}}/g, i18n.t("TOTP_SETUP_ENV_NOTE"))
      .replace(/{{I18N_SETUP_CONFIRM_LABEL}}/g, i18n.t("TOTP_SETUP_CONFIRM_LABEL"))
      .replace(/{{I18N_TOTP_PLACEHOLDER}}/g, i18n.t("TOTP_PLACEHOLDER"))
      .replace(/{{I18N_SETUP_SUBMIT}}/g, i18n.t("TOTP_SETUP_SUBMIT"))
      .replace("{{QR_DATA_URI}}", () => qrDataUri)
      .replace(/{{TOTP_SECRET}}/g, secret)
      .replace(/{{SETUP_TOKEN}}/g, setupToken)
      .replace(/{{ERROR}}/, error ? `<div class="error">${escapeHtml(error.message)}</div>` : ""),
  )
}

const limiter = new RateLimiter()

export const router = Router()

router.use(async (req, res, next) => {
  const to = (typeof req.query.to === "string" && req.query.to) || "/"
  if (await authenticated(req)) {
    return redirect(req, res, to, { to: undefined })
  }
  next()
})

router.get("/", async (req, res) => {
  res.send(await getRoot(req))
})

const logFailedAttempt = (req: Request): void => {
  console.error(
    "Failed login attempt",
    JSON.stringify({
      xForwardedFor: req.headers["x-forwarded-for"],
      remoteAddress: req.connection.remoteAddress,
      userAgent: req.headers["user-agent"],
      timestamp: Math.floor(new Date().getTime() / 1000),
    }),
  )
}

/**
 * A ban just triggered: issue single-use recovery links, put them in the
 * server logs (the guaranteed channel), and best-effort email them to
 * $OWNER_EMAIL directly via the recipient's MX.
 */
const notifyBan = async (req: Request, ip: string, level: "temporary" | "permanent"): Promise<void> => {
  const unbanToken = await req.ipBan.issueToken("unban", ip)
  const resetToken = await req.ipBan.issueToken("reset-2fa", ip)
  const host = getHost(req)
  const base = host ? `https://${host}` : ""
  const unbanUrl = `${base}/unban?token=${unbanToken}`
  const resetUrl = `${base}/unban?token=${resetToken}`
  const what = level === "permanent" ? "PERMANENTLY BANNED" : "temporarily blocked (15 minutes)"

  req.ipBan.audit(level === "permanent" ? "permanent_ban" : "temp_block", ip)
  logger.error(`SECURITY: ${ip} ${what} after repeated failed logins`)
  logger.error(`  Unban this IP:      ${unbanUrl}`)
  logger.error(`  Unban + reset 2FA:  ${resetUrl}`)

  const owner = process.env.OWNER_EMAIL
  if (owner) {
    const text = [
      `The address ${ip} was ${what} after repeated failed logins on ${host || "your Digital Twin instance"}.`,
      "",
      `If this was you, use one of these single-use links (valid 24 hours):`,
      "",
      `Unban the IP:              ${unbanUrl}`,
      `Unban and reset 2FA:       ${resetUrl}`,
      "",
      "You can also manage bans at /security while logged in, or find these",
      "links in the deployment logs.",
    ].join("\n")
    sendMail(owner, `[Digital Twin] login ${level === "permanent" ? "ban" : "block"}: ${ip}`, text)
      .then((ok) => req.ipBan.audit(ok ? "email_sent" : "email_failed", ip, { to: owner }))
      .catch(() => undefined)
  } else {
    logger.info("Set $OWNER_EMAIL to also receive these recovery links by email.")
  }
}

/**
 * Record a failed credential attempt against the client address and escalate
 * to a block/ban when the thresholds are crossed.
 */
const registerFailure = async (req: Request, event: string): Promise<void> => {
  const ip = getClientIp(req)
  req.ipBan.audit(event, ip, { userAgent: req.headers["user-agent"] })
  const escalated = await req.ipBan.recordFailure(ip)
  if (escalated) {
    await notifyBan(req, ip, escalated)
  }
}

interface LoginBody {
  password?: string
  base?: string
  code?: string
  "setup-token"?: string
}

router.post<{}, string, LoginBody | undefined, { to?: string }>("/", async (req, res) => {
  const password = sanitizeString(req.body?.password)
  const code = sanitizeString(req.body?.code)
  const setupToken = sanitizeString(req.body?.["setup-token"])
  const hashedPasswordFromArgs = req.args["hashed-password"]
  const to = (typeof req.query.to === "string" && req.query.to) || "/"
  const clientIp = getClientIp(req)

  // Banned addresses are refused before any credential handling.
  const banStatus = await req.ipBan.status(clientIp)
  if (banStatus.banned) {
    req.ipBan.audit("blocked_attempt", clientIp, { userAgent: req.headers["user-agent"] })
    const message = banStatus.permanent
      ? (i18n.t("IP_BANNED") as string)
      : (i18n.t("IP_TEMP_BLOCKED", { minutes: Math.max(1, Math.ceil((banStatus.retryInMs || 0) / 60000)) }) as string)
    res.send(await getRoot(req, new Error(message)))
    return
  }

  // Confirmation step of first-time two-factor enrollment.  The setup token
  // was only handed out after a successful password check, so possession of a
  // valid token proves the first factor.
  if (setupToken) {
    const pendingSecret = req.twoFactor.getPendingSetup(setupToken)
    try {
      if (!limiter.canTry()) {
        throw new Error(i18n.t("LOGIN_RATE_LIMIT") as string)
      }
      if (!pendingSecret) {
        limiter.removeToken()
        await registerFailure(req, "bad_setup_token")
        throw new Error(i18n.t("TOTP_SETUP_EXPIRED") as string)
      }
      if (!code) {
        throw new Error(i18n.t("MISS_TOTP_CODE") as string)
      }
      if (!(await req.twoFactor.completeSetup(setupToken, code))) {
        limiter.removeToken()
        logFailedAttempt(req)
        await registerFailure(req, "bad_code")
        throw new Error(i18n.t("INCORRECT_TOTP_CODE") as string)
      }

      await req.ipBan.recordSuccess(clientIp)
      req.ipBan.audit("setup_complete", clientIp)
      const totpSecret = await req.twoFactor.getSecret()
      res.cookie(req.cookieSessionName, issueSessionToken(totpSecret!), getCookieOptions(req))
      return redirect(req, res, to, { to: undefined })
    } catch (error: any) {
      // Without a pending secret the setup page cannot be rendered again;
      // send the user back to the password prompt.
      if (!pendingSecret) {
        res.send(await getRoot(req, error))
        return
      }
      res.send(await getSetupRoot(req, setupToken, pendingSecret, error))
      return
    }
  }

  try {
    // Check to see if they exceeded their login attempts
    if (!limiter.canTry()) {
      throw new Error(i18n.t("LOGIN_RATE_LIMIT") as string)
    }

    if (!password) {
      throw new Error(i18n.t("MISS_PASSWORD") as string)
    }

    const passwordMethod = getPasswordMethod(hashedPasswordFromArgs)
    const { isPasswordValid, hashedPassword } = await handlePasswordValidation({
      passwordMethod,
      hashedPasswordFromArgs,
      passwordFromRequestBody: password,
      passwordFromArgs: req.args.password,
    })

    if (isPasswordValid) {
      const totpSecret = await req.twoFactor.getSecret()

      if (totpSecret) {
        // Enrolled: the 6-digit code must accompany the password.
        if (!code) {
          throw new Error(i18n.t("MISS_TOTP_CODE") as string)
        }
        if (!req.twoFactor.consumeCode(totpSecret, code)) {
          limiter.removeToken()
          logFailedAttempt(req)
          await registerFailure(req, "bad_code")
          throw new Error(i18n.t("INCORRECT_TOTP_CODE") as string)
        }

        await req.ipBan.recordSuccess(clientIp)
        req.ipBan.audit("login_ok", clientIp)
        res.cookie(req.cookieSessionName, issueSessionToken(totpSecret), getCookieOptions(req))
        return redirect(req, res, to, { to: undefined })
      }

      if (req.twoFactor.enabled) {
        // First sign-in without two-factor: walk through enrollment before
        // granting a session.
        const setup = req.twoFactor.beginSetup()
        res.send(await getSetupRoot(req, setup.token, setup.secret))
        return
      }

      // Two-factor disabled: legacy behavior.  The hash does not add any
      // actual security but we do it for obfuscation purposes (and as a side
      // effect it handles escaping).
      await req.ipBan.recordSuccess(clientIp)
      req.ipBan.audit("login_ok", clientIp)
      res.cookie(req.cookieSessionName, hashedPassword, getCookieOptions(req))
      return redirect(req, res, to, { to: undefined })
    }

    // Note: successful logins should not count against the RateLimiter
    // which is why this logic must come after the successful login logic
    limiter.removeToken()
    logFailedAttempt(req)
    await registerFailure(req, "bad_password")

    throw new Error(i18n.t("INCORRECT_PASSWORD") as string)
  } catch (error: any) {
    const renderedHtml = await getRoot(req, error)
    res.send(renderedHtml)
  }
})
