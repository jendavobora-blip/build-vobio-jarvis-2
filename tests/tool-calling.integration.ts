import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import type { ChatRequestBody, RunEvent } from "../lib/jarvis/types"

const originalFetch = globalThis.fetch
const envKeys = ["DEEPSEEK_API_KEY", "JARVIS_LIVE_ENABLED", "JARVIS_VERCEL_ENV"] as const
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

interface RecordedCall {
  system: string
  hasToolMessage: boolean
}

interface ToolBehavior {
  firstCall?: "tool" | "none"
  finalCall?: "json" | "tool"
  toolName?: string
  arguments?: string
  context?: string
}

function usage(prompt: number, completion: number) {
  return { prompt_tokens: prompt, completion_tokens: completion, prompt_cache_hit_tokens: 0 }
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } })
}

let callCounter = 0

function toolCallResponse(name: string, args: string): Response {
  callCounter += 1
  return jsonResponse({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: `call_${callCounter}`, type: "function", function: { name, arguments: args } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: usage(40, 12),
  })
}

function installFetch(behavior: ToolBehavior = {}): RecordedCall[] {
  callCounter = 0
  const calls: RecordedCall[] = []
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
    const system = request.messages.find((message) => message.role === "system")?.content ?? ""
    const hasToolMessage = request.messages.some((message) => message.role === "tool")
    calls.push({ system, hasToolMessage })

    if (system.includes("search_memory")) {
      const wantsTool = hasToolMessage ? behavior.finalCall === "tool" : behavior.firstCall !== "none"
      if (wantsTool) return toolCallResponse(behavior.toolName ?? "search_memory", behavior.arguments ?? JSON.stringify({ query: "orion" }))
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ context: behavior.context ?? "Shrnutí paměti." }) }, finish_reason: "stop" }],
        usage: usage(45, 18),
      })
    }
    if (system.includes("Role: ROUTER")) {
      return jsonResponse({
        choices: [
          {
            message: { content: JSON.stringify({ rationale: "Test", agents: [{ id: "memory", task: "Vyber relevantní paměť." }] }) },
            finish_reason: "stop",
          },
        ],
        usage: usage(30, 10),
      })
    }
    if (system.includes("Role: FINAL JUDGE")) {
      return jsonResponse({
        choices: [
          {
            message: { content: JSON.stringify({ answer: "Finální odpověď.", nextSteps: [], needsApproval: [] }) },
            finish_reason: "stop",
          },
        ],
        usage: usage(30, 10),
      })
    }
    return jsonResponse({
      choices: [
        {
          message: { content: JSON.stringify({ summary: "Dílčí výstup.", points: ["bod"], data: [], confidence: "střední", warnings: [] }) },
          finish_reason: "stop",
        },
      ],
      usage: usage(25, 8),
    })
  }
  return calls
}

function makeBody(memories: ChatRequestBody["memories"]): ChatRequestBody {
  return {
    message: "Co víš o projektu Orion?",
    mode: "universal",
    depth: "quick",
    model: "deepseek-flash",
    reasoning: false,
    enabledAgents: ["memory"],
    budget: { maxTokens: 500_000, maxCostUsd: 5 },
    memories,
  }
}

function statusEvents(events: RunEvent[]) {
  return events.filter((event) => event.type === "agent_status") as unknown as {
    agent?: string
    status?: string
    activity?: string
  }[]
}

function errorEvents(events: RunEvent[]) {
  return events.filter((event) => event.type === "agent_error") as unknown as { agent?: string; message?: string }[]
}

const orionMemory: ChatRequestBody["memories"] = [
  { id: "m1", category: "projects", title: "Projekt Orion", content: "Orion je interní projekt zaměřený na orchestraci agentů." },
]

test("search_memory tool round succeeds and records invocation and outcome", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  const calls = installFetch({ firstCall: "tool", finalCall: "json", context: "Orion je interní projekt." })

  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  const result = await runOrchestration({
    body: makeBody(orionMemory),
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
  })

  const toolCalls = calls.filter((call) => call.system.includes("search_memory"))
  assert.equal(toolCalls.length, 2)
  assert.equal(toolCalls[0].hasToolMessage, false)
  assert.equal(toolCalls[1].hasToolMessage, true)

  const statuses = statusEvents(events)
  assert.ok(statuses.some((status) => status.agent === "memory" && status.activity === "search_memory: 1 výsledků"))
  assert.ok(statuses.some((status) => status.agent === "memory" && status.activity === "Tool dokončen: 1 výsledků"))
  assert.equal(errorEvents(events).filter((event) => event.agent === "memory").length, 0)
  assert.ok(events.some((event) => event.type === "final"))
  assert.ok(result.promptTokens > 0)
})

test("unknown tool name is rejected visibly and not reported as success", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  installFetch({ firstCall: "tool", finalCall: "json", toolName: "delete_everything" })

  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  await runOrchestration({
    body: makeBody(orionMemory),
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
  })

  const memoryErrors = errorEvents(events).filter((event) => event.agent === "memory")
  assert.ok(memoryErrors.some((event) => String(event.message).includes("Nepovolený") || String(event.message).includes("Neznámý")))
  const statuses = statusEvents(events)
  assert.ok(!statuses.some((status) => status.activity?.startsWith("Tool dokončen")))
})

test("invalid tool arguments are rejected visibly", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  installFetch({ firstCall: "tool", finalCall: "json", arguments: "tohle-není-json" })

  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  await runOrchestration({
    body: makeBody(orionMemory),
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
  })

  const memoryErrors = errorEvents(events).filter((event) => event.agent === "memory")
  assert.ok(memoryErrors.some((event) => String(event.message).includes("JSON")))
  const statuses = statusEvents(events)
  assert.ok(!statuses.some((status) => status.activity?.startsWith("Tool dokončen")))
})

test("tool calls are capped to a single round even if the model keeps requesting tools", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  const calls = installFetch({ firstCall: "tool", finalCall: "tool" })

  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  await runOrchestration({
    body: makeBody(orionMemory),
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
  })

  const executions = statusEvents(events).filter((status) => status.activity?.startsWith("search_memory:"))
  assert.equal(executions.length, 1)
  assert.ok(!statusEvents(events).some((status) => status.activity?.startsWith("Tool dokončen")))

  const toolCalls = calls.filter((call) => call.system.includes("search_memory"))
  // 1 first round + up to MAX_ATTEMPTS for the final JSON call; never an extra tool execution round.
  assert.ok(toolCalls.length <= 3)
  assert.ok(errorEvents(events).some((event) => event.agent === "memory"))
})

test("budget exhaustion skips the tool visibly without calling the model", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  const calls = installFetch({ firstCall: "tool", finalCall: "json" })

  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  await runOrchestration({
    body: makeBody(orionMemory),
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 200, maxCostUsd: 0.0005 },
  })

  const budgetStops = events.filter((event) => event.type === "budget_stop") as unknown as { reason?: string }[]
  assert.ok(budgetStops.some((stop) => String(stop.reason).includes("search_memory")))
  assert.equal(calls.filter((call) => call.system.includes("search_memory")).length, 0)
})

test("memory agent disabled never starts search_memory", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  const calls = installFetch({ firstCall: "tool", finalCall: "json" })
  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  const body = { ...makeBody(orionMemory), enabledAgents: [] as ChatRequestBody["enabledAgents"] }
  await runOrchestration({
    body,
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
  })
  assert.equal(calls.filter((call) => call.system.includes("search_memory")).length, 0)
  assert.ok(statusEvents(events).some((status) => status.agent === "memory" && status.status === "skipped"))
})

test("multiple tool_calls are rejected and none is executed", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  callCounter = 0
  let toolCallsSeen = 0
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
    const system = request.messages.find((message) => message.role === "system")?.content ?? ""
    if (system.includes("search_memory")) {
      toolCallsSeen++
      return jsonResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [
              { id: "one", type: "function", function: { name: "search_memory", arguments: JSON.stringify({ query: "orion" }) } },
              { id: "two", type: "function", function: { name: "search_memory", arguments: JSON.stringify({ query: "orion" }) } },
            ],
          },
          finish_reason: "tool_calls",
        }],
        usage: usage(40, 12),
      })
    }
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify({ rationale: "Test", agents: [] }) }, finish_reason: "stop" }],
      usage: usage(30, 10),
    })
  }
  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  await runOrchestration({
    body: makeBody(orionMemory),
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
  })
  assert.equal(toolCallsSeen, 1)
  assert.ok(errorEvents(events).some((event) => event.message?.includes("nejvýše jedno")))
  assert.ok(!statusEvents(events).some((status) => status.activity?.startsWith("search_memory:")))
})

test("API error is emitted explicitly and never converted into an empty success", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  let calls = 0
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
    const system = request.messages.find((message) => message.role === "system")?.content ?? ""
    if (system.includes("search_memory")) {
      calls++
      return new Response("server unavailable", { status: 503 })
    }
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify({ rationale: "Test", agents: [] }) }, finish_reason: "stop" }],
      usage: usage(30, 10),
    })
  }
  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  await runOrchestration({
    body: makeBody(orionMemory),
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
  })
  assert.ok(calls >= 1)
  assert.ok(errorEvents(events).some((event) => event.agent === "memory"))
  assert.ok(statusEvents(events).some((status) => status.agent === "memory" && status.status === "error"))
})

test("concurrent specialist reservations cannot exceed a shared token budget", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  const calls: string[] = []
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
    const system = request.messages.find((message) => message.role === "system")?.content ?? ""
    calls.push(system)
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify({ summary: "výsledek", points: [], data: [], confidence: "vysoká", warnings: [] }) }, finish_reason: "stop" }],
      usage: usage(20, 10),
    })
  }
  const { runOrchestration } = await import("../lib/server/orchestrator")
  const body: ChatRequestBody = {
    ...makeBody(orionMemory),
    depth: "full",
    enabledAgents: ["memory", "researcher", "planner", "analyst"],
  }
  await runOrchestration({
    body,
    emit: () => {},
    signal: new AbortController().signal,
    limits: { maxTokens: 300, maxCostUsd: 0.0005 },
  })
  assert.ok(calls.length <= 4)
})

test("UTF-8 and multilingual payloads use a conservative budget reservation", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify({ context: "unexpected" }) }, finish_reason: "stop" }],
      usage: usage(1, 1),
    })
  }
  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  const body: ChatRequestBody = {
    ...makeBody(orionMemory),
    message: "🧠".repeat(4000) + "漢字".repeat(1000),
  }
  await runOrchestration({
    body,
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 300, maxCostUsd: 0.001 },
  })
  assert.equal(calls, 0)
  assert.ok(events.some((event) => event.type === "budget_stop"))
})
