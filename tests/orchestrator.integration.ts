import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { SPECIALISTS } from "../lib/jarvis/agents"
import type { ChatRequestBody, RunEvent } from "../lib/jarvis/types"

const originalFetch = globalThis.fetch
const originalApiKey = process.env.DEEPSEEK_API_KEY

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY
  else process.env.DEEPSEEK_API_KEY = originalApiKey
})

test("Router delegates to legacy-compatible specialists and Final Judge returns the final answer", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  const calls: string[] = []
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      messages: { role: string; content: string }[]
    }
    const system = request.messages[0]?.content ?? ""
    calls.push(system)
    const data = system.includes("Role: ROUTER")
      ? {
          rationale: "Použij tým pro výzkum a kontrolu.",
          agents: SPECIALISTS.map((id) => ({ id, task: `Zpracuj část pro ${id}.` })),
        }
      : system.includes("Role: FINAL JUDGE")
        ? { answer: "Ověřený syntetický výsledek.", nextSteps: [], needsApproval: [] }
        : {
            summary: "Dílčí výstup testovacího specialisty.",
            points: ["Ověřený mock výstup"],
            data: [],
            confidence: "vysoká",
            warnings: [],
          }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(data) } }],
        usage: { prompt_tokens: 100, completion_tokens: 80, prompt_cache_hit_tokens: 0 },
      }),
      { headers: { "Content-Type": "application/json" } },
    )
  }

  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  const body: ChatRequestBody = {
    message: "Ověř řetězec cílových agentů.",
    mode: "universal",
    depth: "full",
    model: "deepseek-flash",
    reasoning: false,
    enabledAgents: [...SPECIALISTS],
    budget: { maxTokens: 500_000, maxCostUsd: 5 },
    memories: [],
  }
  const result = await runOrchestration({
    body,
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
  })

  assert.ok(calls.some((system) => system.includes("Role: ROUTER")))
  assert.ok(calls.some((system) => system.includes("Role: RESEARCHER")))
  assert.ok(calls.some((system) => system.includes("Role: ARCHITECT")))
  assert.ok(calls.some((system) => system.includes("Role: ANALYST")))
  assert.ok(calls.some((system) => system.includes("Role: CODER")))
  assert.ok(calls.some((system) => system.includes("Role: CRITIC")))
  assert.ok(calls.some((system) => system.includes("Role: FINAL JUDGE")))
  assert.ok(events.some((event) => event.type === "agent_status" && event.agent === "final_judge" && event.status === "done"))
  assert.deepEqual(events.find((event) => event.type === "final")?.result, {
    answer: "Ověřený syntetický výsledek.",
    nextSteps: [],
    needsApproval: [],
  })
  assert.equal(result.promptTokens, calls.length * 100)
})
