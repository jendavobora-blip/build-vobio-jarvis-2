import "server-only"
import { serverConfig } from "./config"
import { estimateCost } from "@/lib/jarvis/pricing"
import type { ModelId, Usage } from "@/lib/jarvis/types"

const ENDPOINT = "https://api.deepseek.com/chat/completions"
const TIMEOUT_MS = 90_000
const MAX_ATTEMPTS = 2

export class DeepSeekError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly fatal = false,
  ) {
    super(message)
  }
}

export interface JsonCallOptions {
  model: ModelId
  system: string
  user: string
  maxTokens: number
  reasoning: boolean
  signal: AbortSignal
}

export interface JsonCallResult<T> {
  data: T
  usage: Usage
  attempts: number
}

function describeStatus(status: number): DeepSeekError {
  if (status === 401) return new DeepSeekError("DeepSeek odmítl API klíč. Zkontrolujte DEEPSEEK_API_KEY.", false, true)
  if (status === 402) return new DeepSeekError("Na účtu DeepSeek není dostatečný kredit.", false, true)
  if (status === 400 || status === 422) return new DeepSeekError("DeepSeek odmítl formát požadavku.", false)
  if (status === 429) return new DeepSeekError("DeepSeek dočasně omezil počet požadavků.", true)
  if (status >= 500) return new DeepSeekError("Služba DeepSeek je dočasně nedostupná.", true)
  return new DeepSeekError(`Neočekávaná odpověď DeepSeek (${status}).`, false)
}

async function callOnce(opts: JsonCallOptions): Promise<{ content: string; usage: Usage }> {
  const key = serverConfig.deepseekKey
  if (!key) throw new DeepSeekError("DeepSeek není nakonfigurován.", false, true)

  const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(TIMEOUT_MS)])
  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        response_format: { type: "json_object" },
        max_tokens: opts.maxTokens,
        thinking: { type: opts.reasoning ? "enabled" : "disabled" },
        ...(opts.reasoning ? { reasoning_effort: "low" } : { temperature: 0.4 }),
        stream: false,
      }),
      signal,
    })
  } catch (error) {
    if (opts.signal.aborted) throw new DeepSeekError("Požadavek byl zrušen.", false, true)
    const timedOut = error instanceof Error && error.name === "TimeoutError"
    throw new DeepSeekError(timedOut ? "DeepSeek neodpověděl včas." : "Nelze se spojit s DeepSeek.", true)
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw describeStatus(response.status)
  }

  const json = (await response.json()) as {
    choices?: { message?: { content?: string | null }; finish_reason?: string }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number }
  }
  const promptTokens = json.usage?.prompt_tokens ?? 0
  const completionTokens = json.usage?.completion_tokens ?? 0
  const cacheHitTokens = json.usage?.prompt_cache_hit_tokens ?? 0
  const usage: Usage = {
    promptTokens,
    completionTokens,
    cacheHitTokens,
    costUsd: estimateCost(opts.model, promptTokens, completionTokens, cacheHitTokens),
  }
  const content = json.choices?.[0]?.message?.content ?? ""
  return { content, usage }
}

function extractJson(content: string): unknown {
  const trimmed = content.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1))
    throw new Error("invalid json")
  }
}

/**
 * Calls DeepSeek in JSON mode with at most MAX_ATTEMPTS attempts. Usage from failed
 * attempts that still consumed tokens is accumulated so cost tracking stays honest.
 */
export async function callJson<T>(
  opts: JsonCallOptions,
  parse: (value: unknown) => T,
): Promise<JsonCallResult<T>> {
  let totalUsage: Usage = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 }
  let lastError: DeepSeekError | undefined
  let attemptsMade = 0

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptsMade = attempt
    try {
      const { content, usage } = await callOnce(opts)
      totalUsage = {
        promptTokens: totalUsage.promptTokens + usage.promptTokens,
        completionTokens: totalUsage.completionTokens + usage.completionTokens,
        cacheHitTokens: totalUsage.cacheHitTokens + usage.cacheHitTokens,
        costUsd: totalUsage.costUsd + usage.costUsd,
      }
      try {
        return { data: parse(extractJson(content)), usage: totalUsage, attempts: attempt }
      } catch {
        lastError = new DeepSeekError("Model vrátil neplatný strukturovaný výstup.", true)
      }
    } catch (error) {
      lastError = error instanceof DeepSeekError ? error : new DeepSeekError("Neznámá chyba při volání modelu.", false)
      if (!lastError.retryable) break
    }
    if (attempt < MAX_ATTEMPTS && !opts.signal.aborted) {
      await new Promise((r) => setTimeout(r, 600 * attempt))
    }
  }
  const error = lastError ?? new DeepSeekError("Volání modelu selhalo.", false)
  Object.assign(error, { usage: totalUsage, attempts: attemptsMade })
  throw error
}
