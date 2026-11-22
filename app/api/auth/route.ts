import { cookies } from "next/headers"
import { z } from "zod"
import { authenticateAccount, createSessionToken, SESSION_COOKIE, verifyAccessCode } from "@/lib/server/auth"
import { serverConfig } from "@/lib/server/config"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"
import { hasValidRequestOrigin } from "@/lib/server/request-security"

export const runtime = "nodejs"

const schema = z.union([
  z.object({ code: z.string().min(1).max(256) }),
  z.object({ email: z.string().email().max(254), password: z.string().min(12).max(128) }),
])

export async function POST(request: Request) {
  if (!hasValidRequestOrigin(request)) return Response.json({ error: "Neplatný původ požadavku." }, { status: 403 })
  if (!serverConfig.accessCode || !serverConfig.ownerId || !serverConfig.sessionSecret || !serverConfig.encryptionSecret) {
    return Response.json(
      { error: "Přihlášení není bezpečně nakonfigurováno. Nastavte JARVIS_ACCESS_CODE, stabilní JARVIS_OWNER_ID, JARVIS_SESSION_SECRET a JARVIS_ENCRYPTION_KEY." },
      { status: 503 },
    )
  }
  let limit
  try {
    limit = await rateLimit(`login:${clientIp(request.headers)}`, 5, 15 * 60_000)
  } catch {
    return Response.json({ error: "Sdílená ochrana přihlášení není dostupná." }, { status: 503 })
  }
  if (!limit.ok) {
    return Response.json(
      { error: `Příliš mnoho pokusů. Zkuste to za ${Math.ceil(limit.retryAfterSec / 60)} min.` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    )
  }
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: "Nesprávný přístupový kód." }, { status: 401 })
  }
  let session: ReturnType<typeof createSessionToken>
  if ("code" in parsed.data) {
    if (!verifyAccessCode(parsed.data.code)) return Response.json({ error: "Nesprávný přístupový kód." }, { status: 401 })
    session = createSessionToken()
  } else {
    try {
      const account = await authenticateAccount(parsed.data.email.trim().toLowerCase(), parsed.data.password)
      session = account ? createSessionToken(account.id, "member", account.sessionVersion) : undefined
    } catch {
      return Response.json({ error: "Přihlášení účtu není dostupné." }, { status: 503 })
    }
    if (!session) return Response.json({ error: "Neplatné přihlašovací údaje." }, { status: 401 })
  }
  if (!session) return Response.json({ error: "Relaci nelze vytvořit." }, { status: 500 })
  const store = await cookies()
  store.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: session.maxAge,
  })
  return Response.json({ ok: true })
}

export async function DELETE(request: Request) {
  if (!hasValidRequestOrigin(request)) return Response.json({ error: "Neplatný původ požadavku." }, { status: 403 })
  const store = await cookies()
  store.set(SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 })
  return Response.json({ ok: true })
}
