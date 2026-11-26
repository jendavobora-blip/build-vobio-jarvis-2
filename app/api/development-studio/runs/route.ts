import { createHmac, randomUUID } from "node:crypto"
import { z } from "zod"
import { createMockDevelopmentStudioRun } from "@/lib/jarvis/development-studio"
import {
  isDatabaseConfigured,
  getDevelopmentStudioRun,
  listDevelopmentStudioEvents,
  listDevelopmentStudioRuns,
  DevelopmentStudioIdempotencyConflictError,
  persistDevelopmentStudioMockRun,
} from "@/lib/server/db"
import { authenticatedUser } from "@/lib/server/auth"
import { hasValidRequestOrigin, rateLimitResponse } from "@/lib/server/request-security"
import { isValidRepositoryPath } from "@/lib/github/public-repository"
import { serverConfig } from "@/lib/server/config"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const requestSchema = z.object({
  idempotencyKey: z.string().uuid(),
  repository: z.string().trim().min(3).max(140),
  task: z.string().trim().min(8).max(2000),
}).strict()

const MAX_BODY_BYTES = 12_288
const historyLimit = 20

type JsonBodyResult = { ok: true; value: unknown } | { ok: false; tooLarge: boolean }

async function readBoundedJson(request: Request): Promise<JsonBodyResult> {
  const declaredLength = Number(request.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return { ok: false, tooLarge: true }
  }
  const reader = request.body?.getReader()
  if (!reader) return { ok: false, tooLarge: false }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) {
        await reader.cancel()
        return { ok: false, tooLarge: true }
      }
      chunks.push(value)
    }
    const body = Buffer.concat(chunks).toString("utf8")
    return { ok: true, value: JSON.parse(body) as unknown }
  } catch {
    return { ok: false, tooLarge: false }
  } finally {
    reader.releaseLock()
  }
}

async function authorizedUser(request: Request, write: boolean) {
  if (write && !hasValidRequestOrigin(request)) {
    return Response.json({ error: "Neplatný původ požadavku." }, { status: 403 })
  }
  const user = await authenticatedUser()
  if (!user) return Response.json({ error: "Nejste přihlášeni." }, { status: 401 })
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "Audit běhů vyžaduje DATABASE_URL." }, { status: 501 })
  }
  const limited = await rateLimitResponse(request, `development-studio:${user.id}`, write ? 5 : 30, 60 * 60_000)
  return limited ?? user
}

export async function GET(request: Request) {
  const user = await authorizedUser(request, false)
  if (user instanceof Response) return user
  const runId = new URL(request.url).searchParams.get("runId")
  try {
    if (runId) {
      if (!z.string().uuid().safeParse(runId).success) {
        return Response.json({ error: "Neplatné ID běhu." }, { status: 400 })
      }
      const run = await getDevelopmentStudioRun(user.ownerId, user.id, runId)
      if (!run) return Response.json({ error: "Běh nebyl nalezen." }, { status: 404 })
      const events = await listDevelopmentStudioEvents(user.ownerId, user.id, runId)
      return Response.json({ run, events }, { headers: { "Cache-Control": "no-store" } })
    }
    const runs = await listDevelopmentStudioRuns(user.ownerId, user.id, historyLimit)
    return Response.json({ runs }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return Response.json({ error: "Historii Development Studia nelze načíst." }, { status: 503 })
  }
}

export async function POST(request: Request) {
  const user = await authorizedUser(request, true)
  if (user instanceof Response) return user

  const body = await readBoundedJson(request)
  if (!body.ok) {
    return Response.json(
      { error: body.tooLarge ? "Požadavek je příliš velký." : "Neplatné JSON tělo." },
      { status: body.tooLarge ? 413 : 400 },
    )
  }
  const parsed = requestSchema.safeParse(body.value)
  if (!parsed.success) return Response.json({ error: "Neplatné zadání Development Studia." }, { status: 400 })
  const [owner, repository, extra] = parsed.data.repository.split("/")
  if (!owner || !repository || extra || !isValidRepositoryPath(owner, repository)) {
    return Response.json({ error: "Povoleny jsou pouze veřejné repozitáře ve tvaru vlastník/název." }, { status: 400 })
  }

  const id = randomUUID()
  const hashKey = serverConfig.encryptionSecret ?? serverConfig.sessionSecret
  if (!hashKey) return Response.json({ error: "Auditní klíč není nakonfigurován." }, { status: 503 })
  const taskHash = createHmac("sha256", hashKey).update(parsed.data.task).digest("hex")
  try {
    const run = await createMockDevelopmentStudioRun({
      id,
      repository: parsed.data.repository,
      task: parsed.data.task,
      taskHash,
    })
    const persistence = await persistDevelopmentStudioMockRun(
      user.ownerId,
      user.id,
      parsed.data.idempotencyKey,
      run,
    )
    const events = persistence.created
      ? run.events
      : await listDevelopmentStudioEvents(user.ownerId, user.id, persistence.runId)
    return Response.json(
      {
        run: {
          id: persistence.runId,
          repository: run.repository,
          taskHash: run.taskHash,
          mode: run.mode,
          status: run.status,
          replayed: !persistence.created,
        },
        plan: run.plan,
        events,
      },
      { status: persistence.created ? 201 : 200, headers: { "Cache-Control": "no-store" } },
    )
  } catch (error) {
    if (error instanceof DevelopmentStudioIdempotencyConflictError) {
      return Response.json({ error: error.message }, { status: 409 })
    }
    return Response.json({ error: "Mock běh nebylo možné bezpečně uložit." }, { status: 503 })
  }
}
