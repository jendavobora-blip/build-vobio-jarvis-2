import { cookies } from "next/headers"
import { z } from "zod"
import { createSessionToken, SESSION_COOKIE, verifyAccessCode } from "@/lib/server/auth"
import { serverConfig } from "@/lib/server/config"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"

export const runtime = "nodejs"

const schema = z.object({ code: z.string().min(1).max(256) })

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
  if (!serverConfig.accessCode || !serverConfig.ownerId || !serverConfig.sessionSecret || !serverConfig.encryptionSecret) {
    return Response.json(
      { error: "Přihlášení není bezpečně nakonfigurováno. Nastavte JARVIS_ACCESS_CODE, stabilní JARVIS_OWNER_ID, JARVIS_SESSION_SECRET a JARVIS_ENCRYPTION_KEY." },
      { status: 503 },
    )
  }
  const limit = rateLimit(`login:${clientIp(request.headers)}`, 5, 15 * 60_000)
  if (!limit.ok) {
    return Response.json(
      { error: `Příliš mnoho pokusů. Zkuste to za ${Math.ceil(limit.retryAfterSec / 60)} min.` },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    )
  }
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success || !verifyAccessCode(parsed.data.code)) {
    return Response.json({ error: "Nesprávný přístupový kód." }, { status: 401 })
  }
  const session = createSessionToken()
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

export async function DELETE() {
  const store = await cookies()
  store.set(SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 })
  return Response.json({ ok: true })
}
