import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { SPECIALISTS } from "../lib/jarvis/agents"
import type { ChatRequestBody, RunEvent } from "../lib/jarvis/types"
import {
  createSessionToken,
  decryptText,
  encryptText,
  hashAccountPassword,
  isValidSessionToken,
  ownerId,
  verifyAccountPassword,
} from "../lib/server/auth"

const originalFetch = globalThis.fetch
const envKeys = ["DEEPSEEK_API_KEY", "JARVIS_OWNER_ID", "JARVIS_SESSION_SECRET", "JARVIS_ENCRYPTION_KEY", "JARVIS_ACCESS_CODE"]
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
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

test("invited account passwords are salted and verified without storing plaintext", async () => {
  const password = "test-only-password-4-accounts"
  const encoded = await hashAccountPassword(password)
  const independentlySalted = await hashAccountPassword(password)
  assert.notEqual(encoded, password)
  assert.notEqual(encoded, independentlySalted)
  assert.match(encoded, /^scrypt-v1:/)
  assert.equal(await verifyAccountPassword(password, encoded), true)
  assert.equal(await verifyAccountPassword("different-password", encoded), false)
})

test("owner identity and data encryption are independent of session and provider key rotation", () => {
  process.env.JARVIS_OWNER_ID = "3a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d"
  process.env.JARVIS_SESSION_SECRET = "a".repeat(40)
  process.env.JARVIS_ENCRYPTION_KEY = "b".repeat(40)
  process.env.JARVIS_ACCESS_CODE = "old-access-code"
  process.env.DEEPSEEK_API_KEY = "old-provider-key"

  const stableId = ownerId()
  const session = createSessionToken()
  assert.ok(session)
  const encrypted = encryptText("recoverable sensitive data")

  process.env.JARVIS_ACCESS_CODE = "new-access-code"
  process.env.DEEPSEEK_API_KEY = "new-provider-key"
  assert.equal(ownerId(), stableId)
  assert.equal(isValidSessionToken(session.token), true)
  assert.equal(decryptText(encrypted), "recoverable sensitive data")

  process.env.JARVIS_SESSION_SECRET = "c".repeat(40)
  assert.equal(ownerId(), stableId)
  assert.equal(isValidSessionToken(session.token), false)
  assert.equal(decryptText(encrypted), "recoverable sensitive data")
})
