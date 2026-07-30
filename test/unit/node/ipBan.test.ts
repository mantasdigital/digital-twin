import * as http from "http"
import * as path from "path"
import {
  getClientIp,
  IpBanProvider,
  PERMANENT_THRESHOLD,
  TEMP_BLOCK_MS,
  TEMP_BLOCK_THRESHOLD,
} from "../../../src/node/ipBan"
import { tmpdir } from "../../utils/helpers"

const fakeReq = (headers: http.IncomingHttpHeaders, remoteAddress?: string): http.IncomingMessage => {
  return { headers, socket: { remoteAddress } } as unknown as http.IncomingMessage
}

describe("getClientIp", () => {
  it("should use the rightmost X-Forwarded-For entry", () => {
    expect(getClientIp(fakeReq({ "x-forwarded-for": "1.2.3.4" }, "10.0.0.1"))).toBe("1.2.3.4")
    expect(getClientIp(fakeReq({ "x-forwarded-for": "9.9.9.9, 1.2.3.4" }, "10.0.0.1"))).toBe("1.2.3.4")
  })

  it("should fall back to the socket address", () => {
    expect(getClientIp(fakeReq({}, "10.0.0.1"))).toBe("10.0.0.1")
    expect(getClientIp(fakeReq({}))).toBe("unknown")
  })
})

describe("IpBanProvider", () => {
  let testDir: string

  beforeAll(async () => {
    testDir = await tmpdir("ip-ban-provider")
  })

  const freshProvider = (name: string) => new IpBanProvider(path.join(testDir, `${name}.json`))

  it("should escalate to a temporary block at the threshold", async () => {
    const provider = freshProvider("temp")
    const ip = "1.2.3.4"
    for (let i = 1; i < TEMP_BLOCK_THRESHOLD; i++) {
      expect(await provider.recordFailure(ip)).toBeUndefined()
      expect((await provider.status(ip)).banned).toBe(false)
    }
    expect(await provider.recordFailure(ip)).toBe("temporary")
    const status = await provider.status(ip)
    expect(status.banned).toBe(true)
    expect(status.permanent).toBe(false)
    expect(status.retryInMs).toBeGreaterThan(0)
    expect(status.retryInMs).toBeLessThanOrEqual(TEMP_BLOCK_MS)
  })

  it("should lift a temporary block after it expires", async () => {
    const provider = freshProvider("expire")
    const ip = "1.2.3.4"
    for (let i = 0; i < TEMP_BLOCK_THRESHOLD; i++) {
      await provider.recordFailure(ip)
    }
    expect((await provider.status(ip)).banned).toBe(true)
    expect((await provider.status(ip, Date.now() + TEMP_BLOCK_MS + 1)).banned).toBe(false)
  })

  it("should escalate to a permanent ban", async () => {
    const provider = freshProvider("perma")
    const ip = "5.6.7.8"
    let sawPermanent = false
    for (let i = 1; i <= PERMANENT_THRESHOLD; i++) {
      const level = await provider.recordFailure(ip)
      if (i === PERMANENT_THRESHOLD) {
        expect(level).toBe("permanent")
        sawPermanent = true
      }
    }
    expect(sawPermanent).toBe(true)
    const status = await provider.status(ip, Date.now() + 365 * 24 * 60 * 60 * 1000)
    expect(status.banned).toBe(true)
    expect(status.permanent).toBe(true)
  })

  it("should clear the counter on success and on unban", async () => {
    const provider = freshProvider("clear")
    const ip = "4.4.4.4"
    for (let i = 0; i < TEMP_BLOCK_THRESHOLD; i++) {
      await provider.recordFailure(ip)
    }
    expect((await provider.status(ip)).banned).toBe(true)
    await provider.unban(ip)
    expect((await provider.status(ip)).banned).toBe(false)
    expect(await provider.recordFailure(ip)).toBeUndefined()
    await provider.recordSuccess(ip)
    expect((await provider.list())[ip]).toBeUndefined()
  })

  it("should persist bans across provider instances", async () => {
    const file = path.join(testDir, "persist.json")
    const provider = new IpBanProvider(file)
    const ip = "8.8.8.8"
    for (let i = 0; i < PERMANENT_THRESHOLD; i++) {
      await provider.recordFailure(ip)
    }
    const reloaded = new IpBanProvider(file)
    const status = await reloaded.status(ip)
    expect(status.banned).toBe(true)
    expect(status.permanent).toBe(true)
  })

  it("should issue single-use expiring tokens", async () => {
    const provider = freshProvider("tokens")
    const token = await provider.issueToken("unban", "1.1.1.1")
    expect(token).toMatch(/^[a-f0-9]{64}$/)

    expect(await provider.consumeToken("nonsense")).toBeUndefined()
    expect(await provider.consumeToken("a".repeat(64))).toBeUndefined()

    const entry = await provider.consumeToken(token)
    expect(entry).toEqual(expect.objectContaining({ action: "unban", ip: "1.1.1.1" }))
    // Single use.
    expect(await provider.consumeToken(token)).toBeUndefined()

    const expired = await provider.issueToken("reset-2fa", "1.1.1.1")
    expect(await provider.consumeToken(expired, Date.now() + 25 * 60 * 60 * 1000)).toBeUndefined()
  })
})
