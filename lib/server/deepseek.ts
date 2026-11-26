import "server-only"
import { serverConfig } from "./config"
import { estimateCost } from "@/lib/jarvis/pricing"
import type { ModelId, Usage } from "@/lib/jarvis/types"

const ENDPOINT = "https://api.deepseek.com/chat/completions"
const TIMEOUT_MS = 90_000
export const MAX_ATTEMPTS = 2

export class DeepSeekError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly fatal = false,
  ) {
    super(message)
  }
}

export type ChatRole = "system" | "user" | "assistant" | "tool"

export interface ToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: ChatRole
  content: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

export interface RawChatOptions {
  model: ModelId
  messages: ChatMessage[]
  maxTokens: number
  reasoning: boolean
  jsonMode: boolean
  tools?: readonly unknown[]
  toolChoice?: "auto" | "none"
  signal: AbortSignal
}

export interface RawChatResult {
  content: string
  toolCalls: ToolCall[]
  finishReason: string
  usage: Usage
}

export interface ChatCallResult extends RawChatResult {
  attempts: number
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

const zeroUsage = (): Usage => ({ promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 })

const mergeUsage = (a: Usage, b: Usage): Usage => ({
  promptTokens: a.promptTokens + b.promptTokens,
  completionTokens: a.completionTokens + b.completionTokens,
  cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
  costUsd: a.costUsd + b.costUsd,
})

function describeStatus(status: number): DeepSeekError {
  if (status === 401) return new DeepSeekError("DeepSeek odmítl API klíč. Zkontrolujte DEEPSEEK_API_KEY.", false, true)
  if (status === 402) return new DeepSeekError("Na účtu DeepSeek není dostatečný kredit.", false, true)
  if (status === 400 || status === 422) return new DeepSeekError("DeepSeek odmítl formát požadavku.", false)
  if (status === 429) return new DeepSeekError("DeepSeek dočasně omezil počet požadavků.", true)
  if (status >= 500) return new DeepSeekError("Služba DeepSeek je dočasně nedostupná.", true)
  return new DeepSeekError(`Neočekávaná odpověď DeepSeek (${status}).`, false)
}

async function postChat(opts: RawChatOptions): Promise<RawChatResult> {
  const key = serverConfig.deepseekKey
  if (!key) throw new DeepSeekError("DeepSeek není nakonfigurován.", false, true)

  const messages = opts.messages.map((message) => {
    const payload: Record<string, unknown> = { role: message.role, content: message.content }
    if (message.tool_call_id) payload.tool_call_id = message.tool_call_id
    if (message.tool_calls && message.tool_calls.length) payload.tool_calls = message.tool_calls
    return payload
  })

  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    max_tokens: opts.maxTokens,
    thinking: { type: opts.reasoning ? "enabled" : "disabled" },
    stream: false,
  }
  if (opts.reasoning) body.reasoning_effort = "low"
  else body.temperature = 0.4
  if (opts.jsonMode) body.response_format = { type: "json_object" }
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools
    body.tool_choice = opts.toolChoice ?? "auto"
  }

  const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(TIMEOUT_MS)])
  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
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
    choices?: {
      message?: { content?: string | null; tool_calls?: ToolCall[] }
      finish_reason?: string
    }[]
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
  const message = json.choices?.[0]?.message
  const content = message?.content ?? ""
  const toolCalls = message && Array.isArray(message.tool_calls) ? message.tool_calls : []
  const finishReason = json.choices?.[0]?.finish_reason ?? "stop"
  return { content, toolCalls, finishReason, usage }
}

/**
 * Low-level chat call with retries for transient transport/server errors.
 * Returns raw content and any tool_calls so callers can implement the
 * DeepSeek tool_calls protocol themselves.
 */
export async function callChat(opts: RawChatOptions): Promise<ChatCallResult> {
  let totalUsage = zeroUsage()
  let lastError: DeepSeekError | undefined
  let attemptsMade = 0

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptsMade = attempt
    try {
      const result = await postChat(opts)
      totalUsage = mergeUsage(totalUsage, result.usage)
      return { ...result, usage: totalUsage, attempts: attempt }
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

/**
 * Chat call that forces JSON mode and retries on invalid structured output.
 * Used to finish a tool round with a small, validated JSON payload.
 */
export async function callChatJson<T>(
  opts: RawChatOptions,
  parse: (value: unknown) => T,
): Promise<JsonCallResult<T> & { toolCalls: ToolCall[]; finishReason: string }> {
  let totalUsage = zeroUsage()
  let lastError: DeepSeekError | undefined
  let attemptsMade = 0

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptsMade = attempt
    try {
      const result = await postChat({ ...opts, jsonMode: true })
      totalUsage = mergeUsage(totalUsage, result.usage)
      try {
        const data = parse(extractJson(result.content))
        return {
          data,
          usage: totalUsage,
          attempts: attempt,
          toolCalls: result.toolCalls,
          finishReason: result.finishReason,
        }
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
  const result = await callChatJson(
    {
      model: opts.model,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      maxTokens: opts.maxTokens,
      reasoning: opts.reasoning,
      jsonMode: true,
      signal: opts.signal,
    },
    parse,
  )
  return { data: result.data, usage: result.usage, attempts: result.attempts }
}
