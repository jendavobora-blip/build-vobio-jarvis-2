import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import type { ChatRequestBody, RunEvent, Usage } from "../lib/jarvis/types"
import { isToolAllowed } from "../lib/server/tool-permissions"
import type { OrchestrationAuditEvent } from "../lib/server/db"

const originalFetch = globalThis.fetch
const envKeys = ["DEEPSEEK_API_KEY", "JARVIS_LIVE_ENABLED", "JARVIS_VERCEL_ENV"] as const
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
const ignoreAudit = async (_event: OrchestrationAuditEvent) => {}

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
  requestBody: string
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
    calls.push({ system, hasToolMessage, requestBody: String(init?.body) })

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

function failureReason(events: OrchestrationAuditEvent[]) {
  const terminal = events.at(-1)
  return terminal?.event === "run_failed" ? terminal.failureReason : undefined
}

const orionMemory: ChatRequestBody["memories"] = [
  { id: "m1", category: "projects", title: "Projekt Orion", content: "Orion je interní projekt zaměřený na orchestraci agentů." },
]

test("server-side tool permissions grant search_memory only to the memory agent", () => {
  assert.equal(isToolAllowed("memory", "search_memory"), true)
  for (const agent of ["orchestrator", "researcher", "planner", "analyst", "creator", "auditor", "final_judge"] as const) {
    assert.equal(isToolAllowed(agent, "search_memory"), false)
  }
  assert.equal(isToolAllowed("memory", "delete_everything"), false)
})

test("search_memory tool round succeeds and records invocation and outcome", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  const calls = installFetch({ firstCall: "tool", finalCall: "json", context: "Orion je interní projekt." })

  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  const audit: OrchestrationAuditEvent[] = []
  const result = await runOrchestration({
    body: makeBody(orionMemory),
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
    audit: async (event) => {
      audit.push(event)
    },
  })

  const toolCalls = calls.filter((call) => call.system.includes("search_memory"))
  assert.equal(toolCalls.length, 2)
  assert.equal(toolCalls[0].hasToolMessage, false)
  assert.equal(toolCalls[1].hasToolMessage, true)

  const statuses = statusEvents(events)
  assert.ok(statuses.some((status) => status.agent === "memory" && status.activity === "search_memory: 1 výsledků"))
  assert.ok(statuses.some((status) => status.agent === "memory" && status.activity === "Tool dokončen: 1 výsledků"))
  assert.equal(errorEvents(events).filter((event) => event.agent === "memory").length, 0)
  assert.deepEqual(audit.map((event) => event.event), ["run_started", "tool_requested", "tool_succeeded", "run_completed"])
  const serializedAudit = JSON.stringify(audit)
  assert.equal(serializedAudit.includes(orionMemory[0]!.content), false)
  assert.equal(serializedAudit.includes("Co víš o projektu Orion?"), false)
  assert.equal(serializedAudit.includes("integration-test-placeholder"), false)
  assert.equal(serializedAudit.includes('"query":"orion"'), false)
  assert.ok(events.some((event) => event.type === "final"))
  assert.ok(result.promptTokens > 0)
})

test("search_memory returns only the account-scoped memories supplied to the run", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  const { runOrchestration } = await import("../lib/server/orchestrator")
  const search = async (id: string, title: string, content: string) => {
    const calls = installFetch({ firstCall: "tool", finalCall: "json" })
    await runOrchestration({
      body: makeBody([{ id, category: "projects", title, content }]),
      emit: () => {},
      signal: new AbortController().signal,
      limits: { maxTokens: 500_000, maxCostUsd: 5 },
      audit: ignoreAudit,
    })
    const toolRound = calls.find((call) => call.system.includes("search_memory") && call.hasToolMessage)
    assert.ok(toolRound)
    const messages = JSON.parse(toolRound.requestBody) as { messages: { role: string; content: string }[] }
    return messages.messages.find((message) => message.role === "tool")?.content ?? ""
  }
  const ownerResult = await search("owner-orion", "Owner Projekt Orion", "Syntetická owner-only data o projektu Orion.")
  const memberResult = await search("member-orion", "Member Projekt Orion", "Syntetická member-only data o projektu Orion.")
  assert.ok(ownerResult.includes("Syntetická owner-only data"))
  assert.equal(ownerResult.includes("member-only"), false)
  assert.ok(memberResult.includes("Syntetická member-only data"))
  assert.equal(memberResult.includes("owner-only"), false)
})

test("unknown tool name is rejected visibly and not reported as success", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  const rawToolName = `search_memory:${orionMemory[0]!.content}`
  installFetch({ firstCall: "tool", finalCall: "json", toolName: rawToolName })

  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  const audit: OrchestrationAuditEvent[] = []
  await runOrchestration({
    body: makeBody(orionMemory),
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
    audit: async (event) => {
      audit.push(event)
    },
  })

  const memoryErrors = errorEvents(events).filter((event) => event.agent === "memory")
  assert.ok(memoryErrors.some((event) => String(event.message).includes("Nepovolený") || String(event.message).includes("Neznámý")))
  assert.deepEqual(audit.map((event) => event.event), ["run_started", "tool_requested", "tool_denied", "run_failed"])
  assert.equal(failureReason(audit), "tool_error")
  const serializedAudit = JSON.stringify(audit)
  assert.equal(serializedAudit.includes(rawToolName), false)
  assert.equal(serializedAudit.includes(orionMemory[0]!.content), false)
  assert.ok(audit.filter((event) => "toolName" in event).every((event) => event.toolName === "unknown_tool"))
  assert.ok(!events.some((event) => event.type === "final"))
  const statuses = statusEvents(events)
  assert.ok(!statuses.some((status) => status.activity?.startsWith("Tool dokončen")))
})

test("invalid tool arguments are rejected visibly", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  installFetch({ firstCall: "tool", finalCall: "json", arguments: "tohle-není-json" })

  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  const audit: OrchestrationAuditEvent[] = []
  await runOrchestration({
    body: makeBody(orionMemory),
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
    audit: async (event) => {
      audit.push(event)
    },
  })

  const memoryErrors = errorEvents(events).filter((event) => event.agent === "memory")
  assert.ok(memoryErrors.some((event) => String(event.message).includes("JSON")))
  assert.equal(failureReason(audit), "tool_error")
  const statuses = statusEvents(events)
  assert.ok(!statuses.some((status) => status.activity?.startsWith("Tool dokončen")))
})

test("tool calls are capped to a single round even if the model keeps requesting tools", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  const calls = installFetch({ firstCall: "tool", finalCall: "tool" })

  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  const audit: OrchestrationAuditEvent[] = []
  await runOrchestration({
    body: makeBody(orionMemory),
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
    audit: async (event) => {
      audit.push(event)
    },
  })

  const executions = statusEvents(events).filter((status) => status.activity?.startsWith("search_memory:"))
  assert.equal(executions.length, 1)
  assert.ok(!statusEvents(events).some((status) => status.activity?.startsWith("Tool dokončen")))

  const toolCalls = calls.filter((call) => call.system.includes("search_memory"))
  // 1 first round + up to MAX_ATTEMPTS for the final JSON call; never an extra tool execution round.
  assert.ok(toolCalls.length <= 3)
  assert.ok(errorEvents(events).some((event) => event.agent === "memory"))
  assert.equal(failureReason(audit), "model_error")
})

test("budget exhaustion skips the tool visibly without calling the model", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  const calls = installFetch({ firstCall: "tool", finalCall: "json" })

  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  const audit: OrchestrationAuditEvent[] = []
  await runOrchestration({
    body: makeBody(orionMemory),
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 200, maxCostUsd: 0.0005 },
    audit: async (event) => {
      audit.push(event)
    },
  })

  const budgetStops = events.filter((event) => event.type === "budget_stop") as unknown as { reason?: string }[]
  assert.ok(budgetStops.some((stop) => String(stop.reason).includes("search_memory")))
  assert.equal(calls.filter((call) => call.system.includes("search_memory")).length, 0)
  assert.equal(failureReason(audit), "budget_exceeded")
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
    audit: ignoreAudit,
  })
  assert.equal(calls.filter((call) => call.system.includes("search_memory")).length, 0)
  assert.ok(statusEvents(events).some((status) => status.agent === "memory" && status.status === "skipped"))
  assert.ok(calls.every((call) => !call.requestBody.includes(orionMemory[0].content)))
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
    if (system.includes("Role: FINAL JUDGE")) {
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ answer: "Finální odpověď.", nextSteps: [], needsApproval: [] }) }, finish_reason: "stop" }],
        usage: usage(30, 10),
      })
    }
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify({ rationale: "Test", agents: [] }) }, finish_reason: "stop" }],
      usage: usage(30, 10),
    })
  }
  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  const audit: OrchestrationAuditEvent[] = []
  await runOrchestration({
    body: makeBody(orionMemory),
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
    audit: async (event) => {
      audit.push(event)
    },
  })
  assert.equal(toolCallsSeen, 1)
  assert.ok(errorEvents(events).some((event) => event.message?.includes("nejvýše jedno")))
  assert.ok(!statusEvents(events).some((status) => status.activity?.startsWith("search_memory:")))
  assert.equal(failureReason(audit), "tool_error")
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
  const audit: OrchestrationAuditEvent[] = []
  await runOrchestration({
    body: makeBody(orionMemory),
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
    audit: async (event) => {
      audit.push(event)
    },
  })
  assert.ok(calls >= 1)
  assert.ok(errorEvents(events).some((event) => event.agent === "memory"))
  assert.ok(statusEvents(events).some((status) => status.agent === "memory" && status.status === "error"))
  assert.equal(failureReason(audit), "model_error")
  assert.ok(!audit.some((event) => event.event === "run_completed"))
  assert.ok(!events.some((event) => event.type === "final"))
})

test("specialist failure closes the run with a terminal failure audit", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  const calls: string[] = []
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
    const system = request.messages.find((message) => message.role === "system")?.content ?? ""
    calls.push(system)
    if (system.includes("Role: RESEARCHER")) return new Response("provider unavailable", { status: 503 })
    if (system.includes("Role: ROUTER")) {
      return jsonResponse({
        choices: [{
          message: { content: JSON.stringify({ rationale: "Test", agents: [
            { id: "researcher", task: "Vyhledej syntetický výzkum." },
            { id: "planner", task: "Připrav syntetický plán." },
          ] }) },
          finish_reason: "stop",
        }],
        usage: usage(30, 10),
      })
    }
    if (system.includes("Role: FINAL JUDGE")) {
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ answer: "Nesmí být publikován úspěšný výsledek.", nextSteps: [], needsApproval: [] }) }, finish_reason: "stop" }],
        usage: usage(30, 10),
      })
    }
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify({ summary: "Dílčí plán.", points: ["bod"], data: [], confidence: "střední", warnings: [] }) }, finish_reason: "stop" }],
      usage: usage(25, 8),
    })
  }

  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  const audit: OrchestrationAuditEvent[] = []
  await runOrchestration({
    body: { ...makeBody([]), enabledAgents: ["researcher", "planner"] },
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
    audit: async (event) => {
      audit.push(event)
    },
  })

  assert.equal(calls.filter((system) => system.includes("Role: RESEARCHER")).length, 1)
  assert.ok(errorEvents(events).some((event) => event.agent === "researcher"))
  assert.ok(statusEvents(events).some((status) => status.agent === "researcher" && status.status === "error"))
  assert.ok(statusEvents(events).some((status) => status.agent === "planner" && status.status === "done"))
  assert.equal(failureReason(audit), "model_error")
  assert.equal(audit.at(-1)?.event, "run_failed")
  assert.ok(!audit.some((event) => event.event === "run_completed"))
  assert.ok(!events.some((event) => event.type === "final"))
  assert.equal(events.at(-1)?.type, "done")
})

test("final model failure records run_failed and never emits a fallback as final", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
    const system = request.messages.find((message) => message.role === "system")?.content ?? ""
    if (system.includes("Role: FINAL JUDGE")) return new Response("provider unavailable", { status: 502 })
    if (system.includes("search_memory")) {
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ context: "" }) }, finish_reason: "stop" }],
        usage: usage(20, 5),
      })
    }
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify({ rationale: "Test", agents: [{ id: "memory", task: "Zkontroluj paměť." }] }) }, finish_reason: "stop" }],
      usage: usage(20, 5),
    })
  }
  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  const audit: OrchestrationAuditEvent[] = []
  await runOrchestration({
    body: makeBody(orionMemory),
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
    audit: async (event) => {
      audit.push(event)
    },
  })

  assert.equal(failureReason(audit), "model_error")
  assert.ok(!audit.some((event) => event.event === "run_completed"))
  assert.ok(!events.some((event) => event.type === "final"))
  assert.ok(events.some((event) => event.type === "error"))
})

test("aborted orchestration receives one terminal failure audit and performs no model calls", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return jsonResponse({})
  }
  const { runOrchestration } = await import("../lib/server/orchestrator")
  const controller = new AbortController()
  controller.abort()
  const audit: OrchestrationAuditEvent[] = []
  await runOrchestration({
    body: makeBody(orionMemory),
    emit: () => {},
    signal: controller.signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
    audit: async (event) => {
      audit.push(event)
    },
  })
  assert.deepEqual(audit.map((event) => event.event), ["run_started", "run_failed"])
  assert.equal(failureReason(audit), "aborted")
  assert.equal(calls, 0)
})

test("audit persistence failure prevents a success-shaped final response", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  installFetch()
  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  let failure: unknown
  try {
    await runOrchestration({
      body: makeBody([]),
      emit: (event) => events.push(event),
      signal: new AbortController().signal,
      limits: { maxTokens: 500_000, maxCostUsd: 5 },
      audit: async (event) => {
        if (event.event === "run_completed") throw new Error("simulated database outage")
      },
    })
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof Error)
  assert.match(failure.message, /simulated database outage/)
  assert.ok("usage" in failure)
  const failedUsage = (failure as Error & { usage?: Usage }).usage
  assert.ok(failedUsage)
  assert.ok(failedUsage.promptTokens > 0)
  assert.ok(failedUsage.completionTokens > 0)
  assert.ok(failedUsage.costUsd > 0)
  assert.ok(!events.some((event) => event.type === "final" || event.type === "done"))
})

test("tool success audit failure propagates and is never relabeled as tool execution failure", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  installFetch({ firstCall: "tool", finalCall: "json" })
  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  const audit: OrchestrationAuditEvent[] = []
  let failure: unknown
  try {
    await runOrchestration({
      body: makeBody(orionMemory),
      emit: (event) => events.push(event),
      signal: new AbortController().signal,
      limits: { maxTokens: 500_000, maxCostUsd: 5 },
      audit: async (event) => {
        audit.push(event)
        if (event.event === "tool_succeeded") throw new Error("simulated audit database outage")
      },
    })
  } catch (error) {
    failure = error
  }

  assert.ok(failure instanceof Error)
  assert.match(failure.message, /simulated audit database outage/)
  assert.ok("usage" in failure)
  const failedUsage = (failure as Error & { usage?: Usage }).usage
  assert.ok(failedUsage)
  assert.ok(failedUsage.promptTokens > 0)
  assert.ok(failedUsage.completionTokens > 0)
  assert.ok(failedUsage.costUsd > 0)
  assert.ok(!audit.some((event) => event.event === "tool_failed" || event.event === "run_completed"))
  assert.ok(!events.some((event) => event.type === "final" || event.type === "done"))
})

test("tool failure audit failure propagates without misreporting tool success", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  installFetch({ firstCall: "tool", arguments: "not-json" })
  const { runOrchestration } = await import("../lib/server/orchestrator")
  const audit: OrchestrationAuditEvent[] = []
  let failure: unknown
  try {
    await runOrchestration({
      body: makeBody(orionMemory),
      emit: () => {},
      signal: new AbortController().signal,
      limits: { maxTokens: 500_000, maxCostUsd: 5 },
      audit: async (event) => {
        audit.push(event)
        if (event.event === "tool_failed") throw new Error("simulated failed-tool audit outage")
      },
    })

  } catch (error) {
    failure = error
  }

  assert.ok(failure instanceof Error)
  assert.match(failure.message, /simulated failed-tool audit outage/)
  assert.ok("usage" in failure)
  assert.ok(!audit.some((event) => event.event === "tool_succeeded" || event.event === "run_completed"))
})

test("provider transport failures are not retried without reliable usage", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response("unavailable", { status: 503 })
  }
  const { callChat } = await import("../lib/server/deepseek")
  await assert.rejects(callChat({
    model: "deepseek-flash",
    messages: [{ role: "user", content: "test" }],
    maxTokens: 50,
    reasoning: false,
    jsonMode: false,
    signal: new AbortController().signal,
  }))
  assert.equal(calls, 1)
})

test("terminal status selection preserves abort, budget, tool, model, and no-result precedence", async () => {
  const { getRunFailureReason } = await import("../lib/server/orchestrator")
  const base = { aborted: false, budgetStopped: false, toolCallFailed: false, modelFailed: false, synthesized: false }
  assert.equal(getRunFailureReason({ ...base, synthesized: true }), undefined)
  assert.equal(getRunFailureReason(base), "no_result")
  assert.equal(getRunFailureReason({ ...base, modelFailed: true }), "model_error")
  assert.equal(getRunFailureReason({ ...base, toolCallFailed: true, modelFailed: true }), "tool_error")
  assert.equal(getRunFailureReason({ ...base, budgetStopped: true, toolCallFailed: true }), "budget_exceeded")
  assert.equal(getRunFailureReason({ ...base, aborted: true, budgetStopped: true }), "aborted")
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
    audit: ignoreAudit,
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
    audit: ignoreAudit,
  })
  assert.equal(calls, 0)
  assert.ok(events.some((event) => event.type === "budget_stop"))
})
