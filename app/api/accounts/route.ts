import { z } from "zod"
import { authenticatedUser } from "@/lib/server/auth"
import { isDatabaseConfigured, listAccounts, setAccountActive } from "@/lib/server/db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const schema = z.object({ id: z.string().uuid(), active: z.boolean() })

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  if (!origin) return false
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

async function owner() {
  const user = await authenticatedUser()
  if (!user || user.role !== "owner") return undefined
  return user
}

export async function GET() {
  const user = await owner()
  if (!user) return Response.json({ error: "Správa účtů je dostupná pouze vlastníkovi." }, { status: 403 })
  if (!isDatabaseConfigured()) return Response.json({ error: "Správa účtů vyžaduje DATABASE_URL." }, { status: 501 })
  try {
    return Response.json({ items: await listAccounts(user.ownerId) }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return Response.json({ error: "Účty nelze načíst." }, { status: 502 })
  }
}

export async function PUT(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Neplatný původ požadavku." }, { status: 403 })
  const user = await owner()
  if (!user) return Response.json({ error: "Správa účtů je dostupná pouze vlastníkovi." }, { status: 403 })
  if (!isDatabaseConfigured()) return Response.json({ error: "Správa účtů vyžaduje DATABASE_URL." }, { status: 501 })
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
