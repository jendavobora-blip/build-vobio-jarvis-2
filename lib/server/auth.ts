import "server-only"
import { createHash, createHmac, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv } from "node:crypto"
import { cookies } from "next/headers"
import { serverConfig } from "./config"

export const SESSION_COOKIE = "jarvis_session"
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14

function secretMaterial(): string | undefined {
  const explicit = process.env.JARVIS_SESSION_SECRET?.trim()
  if (explicit && explicit.length >= 32) return explicit
  const code = serverConfig.accessCode
  if (!code) return undefined
  // Derived fallback so a single access-code variable is enough; rotating the code invalidates sessions.
  return `derived:${code}:${serverConfig.deepseekKey ?? "no-key"}`
}

function signingKey(): Buffer | undefined {
  const material = secretMaterial()
  return material ? createHash("sha256").update(`sign|${material}`).digest() : undefined
}

export function encryptionKey(): Buffer | undefined {
  const material = secretMaterial()
  return material ? createHash("sha256").update(`enc|${material}`).digest() : undefined
}

function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("base64url")
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest()
  const hb = createHash("sha256").update(b).digest()
  return timingSafeEqual(ha, hb)
}

export function verifyAccessCode(input: string): boolean {
  const code = serverConfig.accessCode
  if (!code) return false
  return safeEqual(input, code)
}

export function createSessionToken(): { token: string; maxAge: number } | undefined {
  const key = signingKey()
  if (!key) return undefined
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS, n: randomBytes(8).toString("hex") }),
  ).toString("base64url")
  return { token: `${payload}.${sign(payload, key)}`, maxAge: SESSION_TTL_SECONDS }
}

export function isValidSessionToken(token: string | undefined): boolean {
  const key = signingKey()
  if (!key || !token) return false
  const [payload, signature] = token.split(".")
  if (!payload || !signature) return false
  if (!safeEqual(sign(payload, key), signature)) return false
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number }
    return typeof data.exp === "number" && data.exp > Date.now() / 1000
  } catch {
    return false
  }
}

export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies()
  return isValidSessionToken(store.get(SESSION_COOKIE)?.value)
}

export function encryptText(plain: string): string {
  const key = encryptionKey()
  if (!key) throw new Error("Šifrovací klíč není k dispozici.")
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  return `enc:v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${data.toString("base64url")}`
}

export function decryptText(value: string): string {
  if (!value.startsWith("enc:v1:")) return value
  const key = encryptionKey()
  if (!key) return "[zašifrováno]"
  const [, , iv, tag, data] = value.split(":")
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"))
    decipher.setAuthTag(Buffer.from(tag, "base64url"))
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8")
  } catch {
    return "[nelze dešifrovat – změnil se tajný klíč]"
  }
}
