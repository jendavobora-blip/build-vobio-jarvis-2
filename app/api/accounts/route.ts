import { z } from "zod"
import { authenticatedUser } from "@/lib/server/auth"
import { isDatabaseConfigured, listAccounts, setAccountActive } from "@/lib/server/db"
import { hasValidRequestOrigin, rateLimitResponse } from "@/lib/server/request-security"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const schema = z.object({ id: z.string().uuid(), active: z.boolean() })

async function owner() {
  const user = await authenticatedUser()
  if (!user || user.role !== "owner") return undefined
  return user
}

export async function GET(request: Request) {
  const user = await owner()
  if (!user) return Response.json({ error: "Správa účtů je dostupná pouze vlastníkovi." }, { status: 403 })
  if (!isDatabaseConfigured()) return Response.json({ error: "Správa účtů vyžaduje DATABASE_URL." }, { status: 501 })
  const limited = await rateLimitResponse(request, `accounts-read:${user.id}`, 60, 60_000)
  if (limited) return limited
  try {
    return Response.json({ items: await listAccounts(user.ownerId) }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return Response.json({ error: "Účty nelze načíst." }, { status: 502 })
  }
}

export async function PUT(request: Request) {
  if (!hasValidRequestOrigin(request)) return Response.json({ error: "Neplatný původ požadavku." }, { status: 403 })
  const user = await owner()
  if (!user) return Response.json({ error: "Správa účtů je dostupná pouze vlastníkovi." }, { status: 403 })
  if (!isDatabaseConfigured()) return Response.json({ error: "Správa účtů vyžaduje DATABASE_URL." }, { status: 501 })
  const limited = await rateLimitResponse(request, `accounts-write:${user.id}`, 10, 60_000)
  if (limited) return limited
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: "Neplatný účet." }, { status: 400 })
  try {
    const updated = await setAccountActive(user.ownerId, parsed.data.id, parsed.data.active)
    if (!updated) return Response.json({ error: "Účet nebyl nalezen." }, { status: 404 })
    return Response.json({ ok: true })
  } catch {
    return Response.json({ error: "Stav účtu nelze změnit." }, { status: 502 })
  }
}
