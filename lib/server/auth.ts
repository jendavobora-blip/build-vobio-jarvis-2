import "server-only"
import { createHash, createHmac, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv, scrypt as scryptCallback } from "node:crypto"
import { cookies } from "next/headers"
import { serverConfig } from "./config"

export const SESSION_COOKIE = "jarvis_session"
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14
const scrypt = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, 64, (error, derived) => {
      if (error) reject(error)
      else resolve(derived)
    })
  })

export interface AuthenticatedUser {
  id: string
  ownerId: string
  role: "owner" | "member"
}

export function accountScope(user: AuthenticatedUser): string | undefined {
  const secret = serverConfig.sessionSecret
  return secret ? createHmac("sha256", secret).update(`status-scope:${user.ownerId}:${user.id}`).digest("base64url") : undefined
}

function secretMaterial(): string | undefined {
  return serverConfig.sessionSecret
}

function signingKey(): Buffer | undefined {
  const material = secretMaterial()
  return material ? createHash("sha256").update(`sign|${material}`).digest() : undefined
}

export function encryptionKey(): Buffer | undefined {
  const material = serverConfig.encryptionSecret
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

export function createSessionToken(
  userId = ownerId(),
  role: AuthenticatedUser["role"] = "owner",
  sessionVersion = 0,
): { token: string; maxAge: number } | undefined {
  const key = signingKey()
  const tenantOwnerId = ownerId()
  if (!key || !tenantOwnerId || !userId || (role === "owner" && userId !== tenantOwnerId)) return undefined
  const payload = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      sub: userId,
      owner: tenantOwnerId,
      role,
      ver: sessionVersion,
      n: randomBytes(8).toString("hex"),
    }),
  ).toString("base64url")
  return { token: `${payload}.${sign(payload, key)}`, maxAge: SESSION_TTL_SECONDS }
}

export function ownerId(): string | undefined {
  return serverConfig.ownerId
}

async function sessionUser(): Promise<AuthenticatedUser | undefined> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (!isValidSessionToken(token)) return undefined
  const payload = token?.split(".")[0]
  if (!payload) return undefined
  let data: { sub?: string; owner?: string; role?: AuthenticatedUser["role"]; ver?: number }
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return undefined
  }
  const tenantOwnerId = ownerId()
  if (!tenantOwnerId || data.owner !== tenantOwnerId || !data.sub) return undefined
  if (data.role === "owner") {
    return data.sub === tenantOwnerId ? { id: data.sub, ownerId: tenantOwnerId, role: "owner" } : undefined
  }
  if (data.role !== "member") return undefined
  const { isActiveAccount } = await import("./db")
  const sessionVersion = data.ver ?? 0
  if (!Number.isInteger(sessionVersion) || sessionVersion < 0 || !(await isActiveAccount(tenantOwnerId, data.sub, sessionVersion))) return undefined
  return { id: data.sub, ownerId: tenantOwnerId, role: "member" }
}

export async function authenticatedUser(): Promise<AuthenticatedUser | undefined> {
  return sessionUser()
}

export async function authenticatedOwnerId(): Promise<string | undefined> {
  return (await sessionUser())?.id
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
  return Boolean(await sessionUser())
}

export async function hashAccountPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt)
  return `scrypt-v1:${salt.toString("base64url")}:${derived.toString("base64url")}`
}

export async function verifyAccountPassword(password: string, encoded: string): Promise<boolean> {
  const [version, saltText, expectedText] = encoded.split(":")
  if (version !== "scrypt-v1" || !saltText || !expectedText) return false
  try {
    const expected = Buffer.from(expectedText, "base64url")
    const actual = await scrypt(password, Buffer.from(saltText, "base64url"))
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

export async function authenticateAccount(
  email: string,
  password: string,
): Promise<{ id: string; sessionVersion: number } | undefined> {
  const tenantOwnerId = ownerId()
  if (!tenantOwnerId) return undefined
  const { findAccountForLogin } = await import("./db")
  const account = await findAccountForLogin(tenantOwnerId, email)
  const dummyHash = `scrypt-v1:${Buffer.alloc(16).toString("base64url")}:${Buffer.alloc(64).toString("base64url")}`
  const validPassword = await verifyAccountPassword(password, account?.password_hash ?? dummyHash)
  return account?.active && validPassword ? { id: account.id, sessionVersion: account.session_version } : undefined
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
  const [, , iv, tag, data] = value.split(":")
  const keys = [encryptionKey()]
  const legacyMaterial = process.env.JARVIS_LEGACY_ENCRYPTION_KEY
  if (legacyMaterial) keys.push(createHash("sha256").update(`enc|${legacyMaterial}`).digest())
  for (const key of keys) {
    if (!key) continue
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"))
      decipher.setAuthTag(Buffer.from(tag, "base64url"))
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8")
    } catch {
      continue
    }
  }
  return "[nelze dešifrovat – ověřte JARVIS_ENCRYPTION_KEY a případný JARVIS_LEGACY_ENCRYPTION_KEY]"
}
