import { logger } from "@coder/logger"
import * as dns from "dns"
import * as net from "net"
import * as os from "os"
import * as tls from "tls"

/**
 * Minimal direct-to-MX SMTP client with no external services.
 *
 * Railway allows outbound port 25 (verified empirically), so we can deliver
 * straight to the recipient's mail exchanger.  Without SPF/DKIM for the
 * sending address the mail may land in spam or be rejected by strict
 * receivers, which is why every notification is also written to the server
 * logs — email is best-effort, the logs are the guaranteed channel.
 */

const SMTP_TIMEOUT_MS = 20 * 1000

class SmtpConversation {
  private buffer = ""
  private pending?: { resolve: (line: string) => void; reject: (error: Error) => void }

  public constructor(private socket: net.Socket) {
    this.attach(socket)
  }

  public attach(socket: net.Socket): void {
    this.socket = socket
    this.buffer = ""
    socket.on("data", (data) => {
      this.buffer += data.toString("utf8")
      this.drain()
    })
    socket.on("error", (error) => this.pending?.reject(error))
    socket.on("close", () => this.pending?.reject(new Error("connection closed")))
  }

  private drain(): void {
    if (!this.pending) {
      return
    }
    // A reply is complete once we see a line like "250 ..." (space after the
    // code, not a dash which marks a continuation).
    const lines = this.buffer.split("\r\n")
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3}(?: |$)/.test(lines[i])) {
        const reply = lines.slice(0, i + 1).join("\r\n")
        this.buffer = lines.slice(i + 1).join("\r\n")
        const { resolve } = this.pending
        this.pending = undefined
        resolve(reply)
        return
      }
    }
  }

  public async command(line: string | undefined, expect: RegExp): Promise<string> {
    const reply = await new Promise<string>((resolve, reject) => {
      this.pending = { resolve, reject }
      if (typeof line !== "undefined") {
        this.socket.write(line + "\r\n")
      }
      this.drain()
    })
    if (!expect.test(reply)) {
      throw new Error(`unexpected reply to ${line ? line.split(" ")[0] : "<connect>"}: ${reply.split("\r\n")[0]}`)
    }
    return reply
  }
}

const resolveMxHosts = async (domain: string): Promise<string[]> => {
  const records = await dns.promises.resolveMx(domain)
  return records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange)
}

const deliverTo = async (mxHost: string, from: string, to: string, message: string): Promise<void> => {
  const socket = net.connect({ host: mxHost, port: 25 })
  socket.setTimeout(SMTP_TIMEOUT_MS, () => socket.destroy(new Error("SMTP timeout")))
  const chat = new SmtpConversation(socket)
  const helloHost = process.env.RAILWAY_PUBLIC_DOMAIN || os.hostname() || "localhost"

  await chat.command(undefined, /^220/)
  let ehlo = await chat.command(`EHLO ${helloHost}`, /^250/)

  // Upgrade to TLS when offered; some receivers require it.
  if (/STARTTLS/i.test(ehlo)) {
    await chat.command("STARTTLS", /^220/)
    const secure = tls.connect({ socket, servername: mxHost, rejectUnauthorized: false })
    secure.setTimeout(SMTP_TIMEOUT_MS, () => secure.destroy(new Error("SMTP TLS timeout")))
    await new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", resolve)
      secure.once("error", reject)
    })
    chat.attach(secure)
    ehlo = await chat.command(`EHLO ${helloHost}`, /^250/)
    await finishDelivery(chat, from, to, message)
    secure.end()
  } else {
    await finishDelivery(chat, from, to, message)
    socket.end()
  }
}

const finishDelivery = async (chat: SmtpConversation, from: string, to: string, message: string): Promise<void> => {
  await chat.command(`MAIL FROM:<${from}>`, /^250/)
  await chat.command(`RCPT TO:<${to}>`, /^25[01]/)
  await chat.command("DATA", /^354/)
  // Dot-stuff lines starting with "." per RFC 5321.
  const body = message.replace(/\r?\n/g, "\r\n").replace(/(^|\r\n)\./g, "$1..")
  await chat.command(body + "\r\n.", /^250/)
  await chat.command("QUIT", /^221/).catch(() => undefined)
}

/**
 * Send a plain-text email directly to the recipient's MX.  Returns true when
 * a mail exchanger accepted the message.  Never throws.
 */
export const sendMail = async (to: string, subject: string, text: string): Promise<boolean> => {
  const domain = to.split("@")[1]
  if (!domain) {
    logger.warn(`invalid notification address "${to}"`)
    return false
  }
  const fromDomain = process.env.RAILWAY_PUBLIC_DOMAIN || os.hostname() || "digital-twin.invalid"
  const from = `digital-twin@${fromDomain}`
  const message = [
    `From: Digital Twin <${from}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${fromDomain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
  ].join("\r\n")

  let hosts: string[]
  try {
    hosts = await resolveMxHosts(domain)
  } catch (error: any) {
    logger.warn(`unable to resolve MX for ${domain}: ${error.message}`)
    return false
  }

  for (const host of hosts.slice(0, 3)) {
    try {
      await deliverTo(host, from, to, message)
      logger.info(`security notification emailed to ${to} via ${host}`)
      return true
    } catch (error: any) {
      logger.warn(`SMTP delivery via ${host} failed: ${error.message}`)
    }
  }
  return false
}
