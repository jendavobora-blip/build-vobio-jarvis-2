import { z } from "zod"
import { isAuthenticated } from "@/lib/server/auth"
import { isLiveAvailable, serverConfig } from "@/lib/server/config"
import { clientIp, rateLimit } from "@/lib/server/rate-limit"
import { getDailyUsage, recordUsage } from "@/lib/server/db"
import { runOrchestration } from "@/lib/server/orchestrator"
import { DeepSeekError } from "@/lib/server/deepseek"
import { SPECIALISTS } from "@/lib/jarvis/agents"
import type { ChatRequestBody, RunEvent } from "@/lib/jarvis/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

const bodySchema = z.object({
  message: z.string().trim().min(2, "Zadání je příliš krátké.").max(4000, "Zadání je příliš dlouhé (max. 4000 znaků)."),
  mode: z.enum(["universal", "investments", "business"]),
  depth: z.enum(["quick", "full"]),
  model: z.enum(["deepseek-flash", "deepseek-v4-pro"]),
  reasoning: z.boolean(),
  enabledAgents: z.array(z.enum(SPECIALISTS as [string, ...string[]])).max(6),
  budget: z.object({
    maxTokens: z.number().int().min(1000).max(500_000),
    maxCostUsd: z.number().min(0.0001).max(5),
  }),
  memories: z
    .array(
      z.object({
        id: z.string().max(64),
        category: z.enum(["preferences", "projects", "business", "investments", "tasks", "history"]),
        title: z.string().max(200),
        content: z.string().max(4000),
      }),
    )
    .max(300),
})

function jsonError(message: string, status: number, extra?: Record<string, unknown>, headers?: HeadersInit) {
  return Response.json({ error: message, ...extra }, { status, headers })
}

export async function POST(request: Request) {
  if (!isLiveAvailable()) {
    return jsonError("Živý režim není nakonfigurován. Aplikace běží v DEMO REŽIMU.", 503, { demo: true })
  }
  if (!(await isAuthenticated())) {
    return jsonError("Pro živý režim se přihlaste přístupovým kódem.", 401)
  }

  const ip = clientIp(request.headers)
  const limit = rateLimit(`chat:${ip}`, serverConfig.limits.runsPerWindow, 10 * 60_000)
  if (!limit.ok) {
    return jsonError(`Příliš mnoho požadavků. Zkuste to znovu za ${limit.retryAfterSec} s.`, 429, undefined, {
      "Retry-After": String(limit.retryAfterSec),
    })
  }

  let parsed: ChatRequestBody
  try {
    const result = bodySchema.safeParse(await request.json())
    if (!result.success) return jsonError(result.error.issues[0]?.message ?? "Neplatný požadavek.", 400)
    parsed = result.data as ChatRequestBody
  } catch {
    return jsonError("Neplatný JSON v požadavku.", 400)
  }

  const daily = await getDailyUsage()
  const dailyRemaining = serverConfig.limits.dailyBudgetUsd - daily.costUsd
  if (dailyRemaining <= 0) {
    return jsonError("Denní rozpočet API je vyčerpán. Limit se obnoví o půlnoci UTC.", 429)
  }

  const limits = {
    maxTokens: Math.min(parsed.budget.maxTokens, serverConfig.limits.maxRequestTokens),
    maxCostUsd: Math.min(parsed.budget.maxCostUsd, serverConfig.limits.maxRequestUsd, dailyRemaining),
  }

  const encoder = new TextEncoder()
  const abort = new AbortController()
  request.signal.addEventListener("abort", () => abort.abort())

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const emit = (event: RunEvent) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          closed = true
        }
      }
      const heartbeat = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`))
          } catch {
            closed = true
          }
        }
      }, 15_000)

      let spent = { costUsd: 0, tokens: 0 }
      try {
        const total = await runOrchestration({ body: parsed, emit, signal: abort.signal, limits })
        spent = { costUsd: total.costUsd, tokens: total.promptTokens + total.completionTokens }
      } catch (error) {
        const message =
          error instanceof DeepSeekError ? error.message : "Při zpracování došlo k neočekávané chybě. Zkuste to znovu."
        if (!(error instanceof DeepSeekError)) {
          console.error("[jarvis] orchestration failed", error instanceof Error ? error.message : error)
        }
        emit({ type: "error", message, at: Date.now() })
        emit({ type: "done", durationMs: 0, at: Date.now() })
      } finally {
        clearInterval(heartbeat)
        await recordUsage(spent.costUsd, spent.tokens)
        if (!closed) {
          closed = true
          controller.close()
        }
      }
    },
    cancel() {
      abort.abort()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
