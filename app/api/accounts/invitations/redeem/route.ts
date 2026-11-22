import { createHash, randomUUID } from "node:crypto"
import { cookies } from "next/headers"
import { z } from "zod"
import { createSessionToken, hashAccountPassword, ownerId, SESSION_COOKIE } from "@/lib/server/auth"
import { isDatabaseConfigured, redeemAccountInvite } from "@/lib/server/db"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"
import { hasValidRequestOrigin } from "@/lib/server/request-security"

export const runtime = "nodejs"

const schema = z.object({
  email: z.string().email().max(254),
  token: z.string().min(32).max(128),
  password: z.string().min(12).max(128),
})

export async function POST(request: Request) {
  if (!hasValidRequestOrigin(request)) return Response.json({ error: "Neplatný původ požadavku." }, { status: 403 })
  const tenantOwnerId = ownerId()
  if (!isDatabaseConfigured() || !tenantOwnerId) return Response.json({ error: "Registrace vyžaduje nakonfigurovanou databázi." }, { status: 503 })
  let limit
  try {
    limit = await rateLimit(`redeem:${clientIp(request.headers)}`, 10, 15 * 60_000)
  } catch {
    return Response.json({ error: "Sdílená ochrana registrace není dostupná." }, { status: 503 })
  }
  if (!limit.ok) return Response.json({ error: "Příliš mnoho pokusů. Zkuste to později." }, { status: 429 })
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: "Pozvánka, e-mail nebo heslo nejsou platné." }, { status: 400 })
  const email = parsed.data.email.trim().toLowerCase()
  const tokenHash = createHash("sha256").update(parsed.data.token).digest("base64url")
  try {
    const passwordHash = await hashAccountPassword(parsed.data.password)
    const userId = await redeemAccountInvite(tenantOwnerId, email, tokenHash, randomUUID(), passwordHash)
    if (!userId) return Response.json({ error: "Pozvánka je neplatná, vypršela nebo již byla použita." }, { status: 400 })
    const session = createSessionToken(userId, "member")
    if (!session) return Response.json({ error: "Relaci nelze vytvořit." }, { status: 503 })
    const store = await cookies()
    store.set(SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: session.maxAge,
    })
    return Response.json({ ok: true })
  } catch {
    return Response.json({ error: "Registraci nelze dokončit." }, { status: 502 })
  }
}
