import { logger } from "@coder/logger"
import * as crypto from "crypto"
import * as express from "express"
import { promises as fs } from "fs"
import * as http from "http"
import * as path from "path"

/**
 * Per-IP login protection.
 *
 * Failed logins escalate per client address: after TEMP_BLOCK_THRESHOLD
 * failures the address is blocked for TEMP_BLOCK_MS, and after
 * PERMANENT_THRESHOLD failures it is banned permanently.  Bans persist on the
 * volume so restarts and redeploys do not clear them.  A successful login
 * clears the counter for that address.
 *
 * Recovery is via single-use unban tokens ("magic links") issued when a ban
 * triggers.  They are always written to the server logs and, best-effort,
 * emailed to $OWNER_EMAIL (see mailer.ts).
 */

export const TEMP_BLOCK_THRESHOLD = 5
export const TEMP_BLOCK_MS = 15 * 60 * 1000
export const PERMANENT_THRESHOLD = 10
export const UNBAN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

export type UnbanAction = "unban" | "reset-2fa"

export interface BanEntry {
  failures: number
  firstFailureAt: number
  lastFailureAt: number
  blockedUntil?: number
  permanent?: boolean
}

interface UnbanTokenEntry {
  action: UnbanAction
  ip: string
  expiresAt: number
}

interface IpBanFileState {
  bans: { [ip: string]: BanEntry }
  tokens: { [nonce: string]: UnbanTokenEntry }
}

export interface BanStatus {
  banned: boolean
  permanent: boolean
  /** Milliseconds until a temporary block lifts. */
  retryInMs?: number
}

/**
 * Best-effort client address.  Behind the Railway edge (or any reverse proxy
 * that appends to X-Forwarded-For) the rightmost entry is the one added by
 * the trusted proxy in front of us.  Without the header, fall back to the
 * socket address.
 */
export const getClientIp = (req: express.Request | http.IncomingMessage): string => {
  const header = req.headers["x-forwarded-for"]
  const raw = Array.isArray(header) ? header[header.length - 1] : header
  if (raw) {
    const parts = raw.split(",")
    const last = parts[parts.length - 1].trim()
    if (last) {
      return last
    }
  }
  return req.socket?.remoteAddress || "unknown"
}

export class IpBanProvider {
  private state?: IpBanFileState
  private readonly auditPath: string

  public constructor(private readonly filePath: string) {
    this.auditPath = path.join(path.dirname(filePath), "auth-audit.jsonl")
  }

  private async load(): Promise<IpBanFileState> {
    if (!this.state) {
      try {
        const raw = JSON.parse(await fs.readFile(this.filePath, "utf8"))
        this.state = { bans: raw.bans || {}, tokens: raw.tokens || {} }
      } catch (error) {
        this.state = { bans: {}, tokens: {} }
      }
    }
    return this.state
  }

  private async save(): Promise<void> {
    if (!this.state) {
      return
    }
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    } catch (error: any) {
      logger.warn(`unable to persist IP bans: ${error.message}`)
    }
  }

  /**
   * Append an event to the audit log.  Fire-and-forget.
   */
  public audit(event: string, ip: string, extra?: object): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ip, ...extra })
    fs.mkdir(path.dirname(this.auditPath), { recursive: true })
      .then(() => fs.appendFile(this.auditPath, line + "\n"))
      .catch((error) => logger.warn(`unable to write auth audit log: ${error.message}`))
  }

  public async status(ip: string, nowMs = Date.now()): Promise<BanStatus> {
    const state = await this.load()
    const entry = state.bans[ip]
    if (!entry) {
      return { banned: false, permanent: false }
    }
    if (entry.permanent) {
      return { banned: true, permanent: true }
    }
    if (entry.blockedUntil && entry.blockedUntil > nowMs) {
      return { banned: true, permanent: false, retryInMs: entry.blockedUntil - nowMs }
    }
    return { banned: false, permanent: false }
  }

  /**
   * Record a failed login attempt.  Returns the block level this attempt
   * escalated to, if any.
   */
  public async recordFailure(ip: string, nowMs = Date.now()): Promise<"temporary" | "permanent" | undefined> {
    const state = await this.load()
    const entry = (state.bans[ip] = state.bans[ip] || { failures: 0, firstFailureAt: nowMs, lastFailureAt: nowMs })
    entry.failures += 1
    entry.lastFailureAt = nowMs

    let escalated: "temporary" | "permanent" | undefined
    if (entry.failures >= PERMANENT_THRESHOLD) {
      if (!entry.permanent) {
        entry.permanent = true
        escalated = "permanent"
      }
    } else if (entry.failures >= TEMP_BLOCK_THRESHOLD && (!entry.blockedUntil || entry.blockedUntil <= nowMs)) {
      entry.blockedUntil = nowMs + TEMP_BLOCK_MS
      escalated = "temporary"
    }

    await this.save()
    return escalated
  }

  public async recordSuccess(ip: string): Promise<void> {
    const state = await this.load()
    if (state.bans[ip]) {
      delete state.bans[ip]
      await this.save()
    }
  }

  public async unban(ip: string): Promise<void> {
    const state = await this.load()
    delete state.bans[ip]
    await this.save()
  }

  public async list(): Promise<{ [ip: string]: BanEntry }> {
    const state = await this.load()
    return { ...state.bans }
  }

  /**
   * Issue a single-use unban token.  The token is only stored server-side;
   * possession of the exact value is what authorizes the action.
   */
  public async issueToken(action: UnbanAction, ip: string, nowMs = Date.now()): Promise<string> {
    const state = await this.load()
    // Prune expired tokens while we are here.
    for (const [nonce, entry] of Object.entries(state.tokens)) {
      if (entry.expiresAt <= nowMs) {
        delete state.tokens[nonce]
      }
    }
    const nonce = crypto.randomBytes(32).toString("hex")
    state.tokens[nonce] = { action, ip, expiresAt: nowMs + UNBAN_TOKEN_TTL_MS }
    await this.save()
    return nonce
  }

  /**
   * Validate and consume a token (single use).
   */
  public async consumeToken(token: string, nowMs = Date.now()): Promise<UnbanTokenEntry | undefined> {
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return undefined
    }
    const state = await this.load()
    const entry = state.tokens[token]
    if (!entry || entry.expiresAt <= nowMs) {
      return undefined
    }
    delete state.tokens[token]
    await this.save()
    return entry
  }
}
