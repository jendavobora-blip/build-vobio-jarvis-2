import { createHash, randomBytes, randomUUID } from "node:crypto"
import { z } from "zod"
import { authenticatedUser } from "@/lib/server/auth"
import { createAccountInvite, isDatabaseConfigured } from "@/lib/server/db"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"

export const runtime = "nodejs"

const schema = z.object({ email: z.string().email().max(254) })

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  if (!origin) return false
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Neplatný původ požadavku." }, { status: 403 })
  const user = await authenticatedUser()
  if (!user || user.role !== "owner") return Response.json({ error: "Pozvánky může vytvářet pouze vlastník." }, { status: 403 })
  if (!isDatabaseConfigured()) return Response.json({ error: "Pozvánky vyžadují DATABASE_URL." }, { status: 501 })
  const limit = rateLimit(`invite:${user.id}:${clientIp(request.headers)}`, 5, 60 * 60_000)
  if (!limit.ok) {
    return Response.json({ error: "Limit pozvánek byl vyčerpán." }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } })
  }
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: "Zadejte platný e-mail." }, { status: 400 })
  const email = parsed.data.email.trim().toLowerCase()
  const token = randomBytes(32).toString("base64url")
  const tokenHash = createHash("sha256").update(token).digest("base64url")
  try {
    const expiresAt = await createAccountInvite(user.ownerId, email, randomUUID(), tokenHash)
    return Response.json({ token, email, expiresAt }, { status: 201, headers: { "Cache-Control": "no-store" } })
  } catch {
    return Response.json({ error: "Pozvánku nelze uložit." }, { status: 502 })
  }
}
