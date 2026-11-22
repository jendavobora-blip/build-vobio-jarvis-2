import { z } from "zod"
import { authenticatedOwnerId } from "@/lib/server/auth"
import { deleteMemory, isDatabaseConfigured, listMemories, upsertMemory } from "@/lib/server/db"

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

async function guard(): Promise<Response | null> {
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "Synchronizovaná paměť vyžaduje DATABASE_URL." }, { status: 501 })
  }
  const ownerId = await authenticatedOwnerId()
  if (!ownerId) return Response.json({ error: "Nejste přihlášeni." }, { status: 401 })
  return null
}

function failure(error: unknown) {
  console.error("[jarvis] memory db error", error instanceof Error ? error.message : error)
  return Response.json({ error: "Databáze je nedostupná. Zkuste to později." }, { status: 502 })
}

export async function GET() {
  const blocked = await guard()
  if (blocked) return blocked
  const ownerId = await authenticatedOwnerId()
  if (!ownerId) return Response.json({ error: "Nejste přihlášeni." }, { status: 401 })
  try {
    return Response.json({ items: await listMemories(ownerId) }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    return failure(error)
  }
}

export async function PUT(request: Request) {
  const blocked = await guard()
  if (blocked) return blocked
  const ownerId = await authenticatedOwnerId()
  if (!ownerId) return Response.json({ error: "Nejste přihlášeni." }, { status: 401 })
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
  const blocked = await guard()
  if (blocked) return blocked
  const ownerId = await authenticatedOwnerId()
  if (!ownerId) return Response.json({ error: "Nejste přihlášeni." }, { status: 401 })
  const id = new URL(request.url).searchParams.get("id")
  if (!id || id.length > 64) return Response.json({ error: "Chybí ID." }, { status: 400 })
  try {
    await deleteMemory(ownerId, id)
    return Response.json({ ok: true })
  } catch (error) {
    return failure(error)
  }
}
