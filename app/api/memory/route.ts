import { z } from "zod"
import { accountScope, authenticatedUser } from "@/lib/server/auth"
import { deleteMemory, isDatabaseConfigured, listMemories, upsertMemory } from "@/lib/server/db"
import { hasValidRequestOrigin, rateLimitResponse } from "@/lib/server/request-security"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const itemSchema = z.object({
  id: z.string().min(1).max(64),
  category: z.enum(["preferences", "projects", "business", "investments", "tasks", "history"]),
  title: z.string().trim().min(1).max(200),
  content: z.string().max(4000),
  sensitive: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

async function guard(request: Request): Promise<{ userId: string } | Response> {
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "Synchronizovaná paměť vyžaduje DATABASE_URL." }, { status: 501 })
  }
  const user = await authenticatedUser()
  if (!user) return Response.json({ error: "Nejste přihlášeni." }, { status: 401 })
  const expectedScope = accountScope(user)
  if (!expectedScope || request.headers.get("x-jarvis-account-scope") !== expectedScope) {
    return Response.json({ error: "Relace se změnila. Obnovte stav účtu." }, { status: 409 })
  }
  return { userId: user.id }
}

function failure(error: unknown) {
  console.error("[jarvis] memory db error", error instanceof Error ? error.message : error)
  return Response.json({ error: "Databáze je nedostupná. Zkuste to později." }, { status: 502 })
}

export async function GET(request: Request) {
  const identity = await guard(request)
  if (identity instanceof Response) return identity
  const ownerId = identity.userId
  try {
    const limited = await rateLimitResponse(request, `memory-read:${ownerId}`, 60, 60_000)
    if (limited) return limited
    return Response.json({ items: await listMemories(ownerId) }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    return failure(error)
  }
}

export async function PUT(request: Request) {
  if (!hasValidRequestOrigin(request)) return Response.json({ error: "Neplatný původ požadavku." }, { status: 403 })
  const identity = await guard(request)
  if (identity instanceof Response) return identity
  const ownerId = identity.userId
  const limited = await rateLimitResponse(request, `memory-write:${ownerId}`, 30, 60_000)
  if (limited) return limited
  const parsed = itemSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: "Neplatná položka paměti." }, { status: 400 })
  try {
    await upsertMemory(ownerId, parsed.data)
    return Response.json({ ok: true })
  } catch (error) {
    return failure(error)
  }
}

export async function DELETE(request: Request) {
  if (!hasValidRequestOrigin(request)) return Response.json({ error: "Neplatný původ požadavku." }, { status: 403 })
  const identity = await guard(request)
  if (identity instanceof Response) return identity
  const ownerId = identity.userId
  const limited = await rateLimitResponse(request, `memory-delete:${ownerId}`, 20, 60_000)
  if (limited) return limited
  const id = new URL(request.url).searchParams.get("id")
  if (!id || id.length > 64) return Response.json({ error: "Chybí ID." }, { status: 400 })
  try {
    await deleteMemory(ownerId, id)
    return Response.json({ ok: true })
  } catch (error) {
    return failure(error)
  }
}
