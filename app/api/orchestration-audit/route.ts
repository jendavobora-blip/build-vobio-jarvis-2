import { authenticatedUser } from "@/lib/server/auth"
import { isDatabaseConfigured, listOrchestrationAudit } from "@/lib/server/db"
import { rateLimitResponse } from "@/lib/server/request-security"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const user = await authenticatedUser()
  if (!user) return Response.json({ error: "Nejste přihlášeni." }, { status: 401 })
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "Audit orchestrace vyžaduje DATABASE_URL." }, { status: 501 })
  }
  const limited = await rateLimitResponse(request, `orchestration-audit-read:${user.id}`, 60, 60_000)
  if (limited) return limited
  try {
    const events = await listOrchestrationAudit(user.ownerId, user.role === "owner" ? undefined : user.id, 200)
    return Response.json({ events }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    console.error("[jarvis] orchestration audit read failed", error instanceof Error ? error.message : error)
    return Response.json({ error: "Auditní databáze není dostupná." }, { status: 502 })
  }
}
