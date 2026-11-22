import { z } from "zod"
import { authenticatedOwnerId } from "@/lib/server/auth"
import { isDatabaseConfigured, createApproval, listApprovalAudit, listApprovals, resolveApproval } from "@/lib/server/db"
import { approvalHash, approvalId, approvalPlanSchema } from "@/lib/server/approvals"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const resolveSchema = z.object({
  id: z.string().uuid(),
  planHash: z.string().length(43),
  decision: z.enum(["approve", "confirm_critical", "deny"]),
})

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  if (!origin) return false
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

async function owner(request: Request): Promise<string | Response> {
  if (!sameOrigin(request)) return Response.json({ error: "Neplatný původ požadavku." }, { status: 403 })
  const ownerId = await authenticatedOwnerId()
  if (!ownerId) return Response.json({ error: "Nejste přihlášeni." }, { status: 401 })
  if (!isDatabaseConfigured()) return Response.json({ error: "Schvalování vyžaduje DATABASE_URL." }, { status: 501 })
  return ownerId
}

export async function GET() {
  const ownerId = await authenticatedOwnerId()
  if (!ownerId) return Response.json({ error: "Nejste přihlášeni." }, { status: 401 })
  if (!isDatabaseConfigured()) return Response.json({ error: "Schvalování vyžaduje DATABASE_URL." }, { status: 501 })
  try {
    const [items, audit] = await Promise.all([listApprovals(ownerId), listApprovalAudit(ownerId)])
    return Response.json({ items, audit }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return Response.json({ error: "Auditní databáze není dostupná." }, { status: 502 })
  }
}

export async function POST(request: Request) {
  const authorized = await owner(request)
  if (authorized instanceof Response) return authorized
  const parsed = approvalPlanSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: "Neplatný schvalovací plán." }, { status: 400 })
  const id = approvalId()
  const planHash = approvalHash(parsed.data)
  try {
    const approval = await createApproval(authorized, id, planHash, JSON.stringify(parsed.data))
    return Response.json({ approval }, { status: 201 })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Schvalování se nezdařilo." }, { status: 409 })
  }
}

export async function PUT(request: Request) {
  const authorized = await owner(request)
  if (authorized instanceof Response) return authorized
  const parsed = resolveSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: "Neplatné rozhodnutí." }, { status: 400 })
  try {
    const approval = await resolveApproval(authorized, parsed.data.id, parsed.data.planHash, parsed.data.decision)
    if (!approval) return Response.json({ error: "Plán nelze změnit nebo jeho hash se neshoduje." }, { status: 409 })
    return Response.json({ approval })
  } catch (error) {
    return Response.json({ error: "Schvalování se nezdařilo." }, { status: 502 })
  }
}
