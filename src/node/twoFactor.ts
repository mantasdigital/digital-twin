import * as crypto from "crypto"
import { promises as fs } from "fs"
import * as path from "path"
import safeCompare from "safe-compare"

/**
 * Two-factor authentication (RFC 6238 TOTP) and the signed session tokens that
 * back it.
 *
 * The TOTP parameters (SHA1, 6 digits, 30 second period) are the defaults
 * understood by 1Password, Google Authenticator, and every other mainstream
 * authenticator.
 *
 * Once a TOTP secret is enrolled the login cookie switches from the legacy
 * hashed-password value to an HMAC-signed session token.  The legacy cookie
 * can be forged by anyone who knows the password, which would defeat the
 * second factor entirely.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export const normalizeBase32 = (secret: string): string => {
  return secret.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "")
}

export const isValidBase32 = (secret: string): boolean => {
  const normalized = normalizeBase32(secret)
  return normalized.length > 0 && /^[A-Z2-7]+$/.test(normalized)
}

export const base32Encode = (buffer: Buffer): string => {
  let bits = 0
  let value = 0
  let output = ""
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }
  return output
}

export const base32Decode = (secret: string): Buffer => {
  const normalized = normalizeBase32(secret)
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) {
      throw new Error(`invalid base32 character "${char}"`)
    }
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

export const TOTP_DIGITS = 6
export const TOTP_STEP_SECONDS = 30
// Accept one step on either side of the current time for clock drift.
const TOTP_WINDOW = 1

const hotp = (key: Buffer, counter: number): string => {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = crypto.createHmac("sha1", key).update(message).digest()
  const offset = digest[digest.length - 1] & 0xf
  const code =
    ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3]
  return (code % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, "0")
}

export const totpCounter = (timeMs: number): number => {
  return Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS)
}

export const generateTotpCode = (secret: string, timeMs = Date.now()): string => {
  return hotp(base32Decode(secret), totpCounter(timeMs))
}

/**
 * Return the counter the code matched at, or undefined if it did not match.
 */
export const matchTotpCode = (secret: string, code: string, timeMs = Date.now()): number | undefined => {
  const normalized = code.replace(/\s/g, "")
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(normalized)) {
    return undefined
  }
  const key = base32Decode(secret)
  const counter = totpCounter(timeMs)
  for (let i = -TOTP_WINDOW; i <= TOTP_WINDOW; i++) {
    if (safeCompare(hotp(key, counter + i), normalized)) {
      return counter + i
    }
  }
  return undefined
}

export const generateTotpSecret = (): string => {
  return base32Encode(crypto.randomBytes(20))
}

export const totpUri = (secret: string, account: string, issuer: string): string => {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const params = new URLSearchParams({
    secret: normalizeBase32(secret),
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

const SESSION_TOKEN_VERSION = "dt1"
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

// The TOTP secret doubles as the signing key material so that instances
// sharing a secret (via $TOTP_SECRET) also accept each other's sessions.
const sessionKey = (secret: string): Buffer => {
  return crypto
    .createHash("sha256")
    .update(`digital-twin-session:${normalizeBase32(secret)}`)
    .digest()
}

const signSessionPayload = (secret: string, payload: string): string => {
  return crypto.createHmac("sha256", sessionKey(secret)).update(payload).digest("hex")
}

export const issueSessionToken = (secret: string, nowMs = Date.now()): string => {
  const expiresAt = nowMs + SESSION_TTL_MS
  const nonce = crypto.randomBytes(16).toString("hex")
  const payload = `${SESSION_TOKEN_VERSION}.${expiresAt}.${nonce}`
  return `${payload}.${signSessionPayload(secret, payload)}`
}

export const verifySessionToken = (secret: string, token: string, nowMs = Date.now()): boolean => {
  const parts = token.split(".")
  if (parts.length !== 4 || parts[0] !== SESSION_TOKEN_VERSION) {
    return false
  }
  const [version, expiresAt, nonce, signature] = parts
  if (!safeCompare(signature, signSessionPayload(secret, `${version}.${expiresAt}.${nonce}`))) {
    return false
  }
  const expires = Number(expiresAt)
  return Number.isFinite(expires) && nowMs < expires
}

interface TwoFactorFileState {
  totpSecret?: string
}

const PENDING_SETUP_TTL_MS = 15 * 60 * 1000

/**
 * Holds the enrolled TOTP secret (from $TOTP_SECRET or two-factor.json in the
 * user data directory) and the in-memory state for pending enrollments and
 * replay protection.
 */
export class TwoFactorProvider {
  private readonly pendingSetups = new Map<string, { secret: string; expiresAt: number }>()
  private readonly usedCounters = new Map<string, number>()
  private fileSecret?: string | null

  public constructor(
    private readonly filePath: string,
    private readonly secretFromEnv?: string,
    public readonly enabled = true,
  ) {}

  public async getSecret(): Promise<string | undefined> {
    if (!this.enabled) {
      return undefined
    }
    if (this.secretFromEnv) {
      return normalizeBase32(this.secretFromEnv)
    }
    if (typeof this.fileSecret === "undefined") {
      try {
        const raw = JSON.parse(await fs.readFile(this.filePath, "utf8")) as TwoFactorFileState
        this.fileSecret = raw.totpSecret && isValidBase32(raw.totpSecret) ? normalizeBase32(raw.totpSecret) : null
      } catch (error) {
        this.fileSecret = null
      }
    }
    return this.fileSecret || undefined
  }

  public async isEnrolled(): Promise<boolean> {
    return !!(await this.getSecret())
  }

  public beginSetup(): { token: string; secret: string } {
    this.prunePendingSetups()
    const token = crypto.randomBytes(24).toString("hex")
    const secret = generateTotpSecret()
    this.pendingSetups.set(token, { secret, expiresAt: Date.now() + PENDING_SETUP_TTL_MS })
    return { token, secret }
  }

  public getPendingSetup(token: string): string | undefined {
    this.prunePendingSetups()
    return this.pendingSetups.get(token)?.secret
  }

  public async completeSetup(token: string, code: string): Promise<boolean> {
    const secret = this.getPendingSetup(token)
    if (!secret || !this.consumeCode(secret, code)) {
      return false
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify({ totpSecret: secret }, null, 2), { mode: 0o600 })
    this.fileSecret = secret
    this.pendingSetups.delete(token)
    return true
  }

  /**
   * Verify a code and burn its counter so the same code cannot be replayed.
   */
  public consumeCode(secret: string, code: string, nowMs = Date.now()): boolean {
    const matched = matchTotpCode(secret, code, nowMs)
    if (typeof matched === "undefined") {
      return false
    }
    const lastUsed = this.usedCounters.get(secret)
    if (typeof lastUsed !== "undefined" && matched <= lastUsed) {
      return false
    }
    this.usedCounters.set(secret, matched)
    return true
  }

  private prunePendingSetups(): void {
    const now = Date.now()
    for (const [token, pending] of this.pendingSetups) {
      if (pending.expiresAt <= now) {
        this.pendingSetups.delete(token)
      }
    }
  }
}
