import { promises as fs } from "fs"
import * as path from "path"
import {
  base32Decode,
  base32Encode,
  generateTotpCode,
  generateTotpSecret,
  isValidBase32,
  issueSessionToken,
  matchTotpCode,
  normalizeBase32,
  SESSION_TTL_MS,
  totpUri,
  TwoFactorProvider,
  verifySessionToken,
} from "../../../src/node/twoFactor"
import { tmpdir } from "../../utils/helpers"

// RFC 6238 test secret: ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"))

describe("base32", () => {
  it("should roundtrip random buffers", () => {
    for (const hex of ["00", "ff", "deadbeef", "0102030405060708090a0b0c0d0e0f1011121314"]) {
      const buffer = Buffer.from(hex, "hex")
      expect(base32Decode(base32Encode(buffer)).toString("hex")).toBe(hex)
    }
  })

  it("should encode the RFC 6238 secret to the well-known value", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
  })

  it("should normalize spaces, dashes, case, and padding", () => {
    expect(normalizeBase32("gezd gnbv-gy3tqojq==")).toBe("GEZDGNBVGY3TQOJQ")
  })

  it("should validate base32 strings", () => {
    expect(isValidBase32("GEZDGNBVGY3TQOJQ")).toBe(true)
    expect(isValidBase32("not base32!")).toBe(false)
    expect(isValidBase32("")).toBe(false)
  })

  it("should throw on invalid characters", () => {
    expect(() => base32Decode("01890")).toThrow()
  })
})

describe("totp", () => {
  // RFC 6238 appendix B vectors (SHA1), truncated to 6 digits.
  const vectors: Array<[number, string]> = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ]

  it.each(vectors)("should generate the RFC 6238 code at t=%d", (seconds, expected) => {
    expect(generateTotpCode(RFC_SECRET, seconds * 1000)).toBe(expected)
  })

  it("should match codes within the drift window", () => {
    const now = 1111111109 * 1000
    // Exact step.
    expect(matchTotpCode(RFC_SECRET, "081804", now)).toBeDefined()
    // One step in the past and future.
    expect(matchTotpCode(RFC_SECRET, generateTotpCode(RFC_SECRET, now - 30000), now)).toBeDefined()
    expect(matchTotpCode(RFC_SECRET, generateTotpCode(RFC_SECRET, now + 30000), now)).toBeDefined()
    // Two steps away should fail.
    expect(matchTotpCode(RFC_SECRET, generateTotpCode(RFC_SECRET, now + 90000), now)).toBeUndefined()
  })

  it("should reject malformed codes", () => {
    const now = 59 * 1000
    expect(matchTotpCode(RFC_SECRET, "28708", now)).toBeUndefined()
    expect(matchTotpCode(RFC_SECRET, "2870820", now)).toBeUndefined()
    expect(matchTotpCode(RFC_SECRET, "28708a", now)).toBeUndefined()
    expect(matchTotpCode(RFC_SECRET, "", now)).toBeUndefined()
  })

  it("should accept codes with spaces", () => {
    expect(matchTotpCode(RFC_SECRET, "287 082", 59 * 1000)).toBeDefined()
  })

  it("should generate 32-character base32 secrets", () => {
    const secret = generateTotpSecret()
    expect(secret).toHaveLength(32)
    expect(isValidBase32(secret)).toBe(true)
  })

  it("should build a 1Password-compatible otpauth URI", () => {
    const uri = totpUri(RFC_SECRET, "twin.example.com", "Digital Twin")
    expect(uri).toBe(
      "otpauth://totp/Digital%20Twin:twin.example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Digital+Twin&algorithm=SHA1&digits=6&period=30",
    )
  })
})

describe("session tokens", () => {
  it("should verify a freshly issued token", () => {
    const token = issueSessionToken(RFC_SECRET)
    expect(verifySessionToken(RFC_SECRET, token)).toBe(true)
  })

  it("should reject tokens signed with a different secret", () => {
    const token = issueSessionToken(RFC_SECRET)
    expect(verifySessionToken(generateTotpSecret(), token)).toBe(false)
  })

  it("should reject expired tokens", () => {
    const token = issueSessionToken(RFC_SECRET, 0)
    expect(verifySessionToken(RFC_SECRET, token, SESSION_TTL_MS + 1)).toBe(false)
    expect(verifySessionToken(RFC_SECRET, token, SESSION_TTL_MS - 1)).toBe(true)
  })

  it("should reject tampered tokens", () => {
    const token = issueSessionToken(RFC_SECRET)
    const parts = token.split(".")
    // Extend the expiry.
    const tampered = [parts[0], String(Number(parts[1]) + 1000), parts[2], parts[3]].join(".")
    expect(verifySessionToken(RFC_SECRET, tampered)).toBe(false)
  })

  it("should reject garbage", () => {
    expect(verifySessionToken(RFC_SECRET, "")).toBe(false)
    expect(verifySessionToken(RFC_SECRET, "dt1.123.abc")).toBe(false)
    expect(verifySessionToken(RFC_SECRET, "$argon2id$somethinglegacy")).toBe(false)
  })
})

describe("TwoFactorProvider", () => {
  let testDir: string

  beforeAll(async () => {
    testDir = await tmpdir("two-factor-provider")
  })

  it("should report no secret when disabled even if env secret is set", async () => {
    const provider = new TwoFactorProvider(path.join(testDir, "none.json"), RFC_SECRET, false)
    expect(await provider.getSecret()).toBeUndefined()
    expect(await provider.isEnrolled()).toBe(false)
  })

  it("should prefer the env secret", async () => {
    const provider = new TwoFactorProvider(path.join(testDir, "none.json"), "gezdgnbvgy3tqojq")
    expect(await provider.getSecret()).toBe("GEZDGNBVGY3TQOJQ")
  })

  it("should complete setup and persist the secret", async () => {
    const filePath = path.join(testDir, "enroll.json")
    const provider = new TwoFactorProvider(filePath)
    expect(await provider.isEnrolled()).toBe(false)

    const setup = provider.beginSetup()
    expect(provider.getPendingSetup(setup.token)).toBe(setup.secret)
    expect(provider.getPendingSetup("bogus")).toBeUndefined()

    // Wrong code does not enroll.
    expect(await provider.completeSetup(setup.token, "000000")).toBe(false)

    const code = generateTotpCode(setup.secret)
    expect(await provider.completeSetup(setup.token, code)).toBe(true)
    expect(await provider.getSecret()).toBe(setup.secret)
    expect(provider.getPendingSetup(setup.token)).toBeUndefined()

    // A fresh provider reads the secret back from disk.
    const reloaded = new TwoFactorProvider(filePath)
    expect(await reloaded.getSecret()).toBe(setup.secret)

    const persisted = JSON.parse(await fs.readFile(filePath, "utf8"))
    expect(persisted.totpSecret).toBe(setup.secret)
  })

  it("should burn codes so they cannot be replayed", () => {
    const provider = new TwoFactorProvider(path.join(testDir, "replay.json"))
    const now = 1111111109 * 1000
    expect(provider.consumeCode(RFC_SECRET, "081804", now)).toBe(true)
    expect(provider.consumeCode(RFC_SECRET, "081804", now)).toBe(false)
    // The next step's code still works.
    const next = generateTotpCode(RFC_SECRET, now + 30000)
    expect(provider.consumeCode(RFC_SECRET, next, now + 30000)).toBe(true)
  })
})
