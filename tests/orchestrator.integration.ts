import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { SPECIALISTS } from "../lib/jarvis/agents"
import type { ChatRequestBody, RunEvent } from "../lib/jarvis/types"
import type { OrchestrationAuditEvent } from "../lib/server/db"
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
const envKeys = ["DEEPSEEK_API_KEY", "JARVIS_OWNER_ID", "JARVIS_SESSION_SECRET", "JARVIS_ENCRYPTION_KEY", "JARVIS_LEGACY_ENCRYPTION_KEY", "JARVIS_ACCESS_CODE"]
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
    audit: async () => {},
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

test("orchestration phases pass prior specialist outputs to Final Judge", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  const calls: { role: string; user: string }[] = []
  let releaseResearcher!: () => void
  const researcherGate = new Promise<void>((resolve) => { releaseResearcher = resolve })
  let markResearcherStarted!: () => void
  const researcherStarted = new Promise<void>((resolve) => { markResearcherStarted = resolve })
  let markOtherSpecialistsDone!: () => void
  const otherSpecialistsDone = new Promise<void>((resolve) => { markOtherSpecialistsDone = resolve })
  const pendingFirstPhase = new Set(["memory", "planner", "analyst"])
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      messages: { role: string; content: string }[]
    }
    const system = request.messages[0]?.content ?? ""
    const user = request.messages.find((message) => message.role === "user")?.content ?? ""
    const role = /Role: (ROUTER|RESEARCHER|STRÁŽCE PAMĚTI|ARCHITECT|ANALYST|CODER|CRITIC|FINAL JUDGE)/.exec(system)?.[1] ?? "unknown"
    calls.push({ role, user })
    if (role === "RESEARCHER") {
      markResearcherStarted()
      await researcherGate
    }
    const data = role === "ROUTER"
      ? {
          rationale: "Použij tým a respektuj fáze.",
          agents: SPECIALISTS.map((id) => ({ id, task: `Úkol pro ${id}.` })),
        }
      : role === "FINAL JUDGE"
        ? { answer: "Výsledky syntetizovány.", nextSteps: [], needsApproval: [] }
        : {
            summary: `výstup-${role}`,
            points: [`bod-${role}`],
            data: [],
            confidence: "vysoká",
            warnings: [],
          }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(data) } }],
      usage: { prompt_tokens: 100, completion_tokens: 80, prompt_cache_hit_tokens: 0 },
    }), { headers: { "Content-Type": "application/json" } })
  }

  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  const body: ChatRequestBody = {
    message: "Ověř přenos výstupů mezi fázemi.",
    mode: "universal",
    depth: "full",
    model: "deepseek-flash",
    reasoning: false,
    enabledAgents: [...SPECIALISTS],
    budget: { maxTokens: 500_000, maxCostUsd: 5 },
    memories: [],
  }
  const run = runOrchestration({
    body,
    emit: (event) => {
      events.push(event)
      if (event.type === "agent_status" && event.status === "done") {
        pendingFirstPhase.delete(event.agent)
        if (pendingFirstPhase.size === 0) markOtherSpecialistsDone()
      }
    },
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
    audit: async () => {},
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all([researcherStarted, otherSpecialistsDone]),
      run.then(() => { throw new Error("Orchestration finished before the researcher was released.") }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("First-phase specialists did not finish in time.")), 10_000)
      }),
    ])
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.ok(!calls.some((call) => call.role === "CODER"))
    assert.ok(!events.some((event) => event.type === "agent_status" && event.agent === "researcher" && event.status === "done"))
  } finally {
    if (timer) clearTimeout(timer)
    releaseResearcher()
    await run
  }

  const plan = events.find((event) => event.type === "plan")
  assert.deepEqual(plan?.selected.map(({ agent }) => agent), SPECIALISTS)
  const callIndex = (role: string) => calls.findIndex((call) => call.role === role)
  const firstPhase = ["RESEARCHER", "STRÁŽCE PAMĚTI", "ARCHITECT", "ANALYST"]
  const firstPhaseIndexes = firstPhase.map(callIndex)
  const creatorIndex = callIndex("CODER")
  const criticIndex = callIndex("CRITIC")
  const judgeIndex = callIndex("FINAL JUDGE")
  assert.ok(calls[0]?.role === "ROUTER")
  assert.ok(firstPhaseIndexes.every((index) => index > 0 && index < creatorIndex))
  assert.ok(creatorIndex < criticIndex && criticIndex < judgeIndex)
  for (const role of firstPhase) assert.ok(calls[creatorIndex]?.user.includes(`výstup-${role}`))
  for (const role of [...firstPhase, "CODER"]) {
    assert.ok(calls[criticIndex]?.user.includes(`výstup-${role}`))
  }
  for (const role of [...firstPhase, "CODER", "CRITIC"]) {
    assert.ok(calls[judgeIndex]?.user.includes(`výstup-${role}`))
  }
})

test("nonfatal researcher failure preserves other work and records a single failed run", async () => {
  process.env.DEEPSEEK_API_KEY = "integration-test-placeholder"
  const calls: string[] = []
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
    const system = request.messages[0]?.content ?? ""
    const role = /Role: (ROUTER|RESEARCHER|STRÁŽCE PAMĚTI|ARCHITECT|ANALYST|CODER|CRITIC|FINAL JUDGE)/.exec(system)?.[1] ?? "unknown"
    calls.push(role)
    if (role === "RESEARCHER") return new Response("invalid request", { status: 400 })
    const data = role === "ROUTER"
      ? { rationale: "Použij tým.", agents: SPECIALISTS.map((id) => ({ id, task: `Úkol pro ${id}.` })) }
      : role === "FINAL JUDGE"
        ? { answer: "Tato odpověď nesmí být zveřejněna.", nextSteps: [], needsApproval: [] }
        : { summary: `výstup-${role}`, points: [], data: [], confidence: "vysoká", warnings: [] }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(data) } }],
      usage: { prompt_tokens: 100, completion_tokens: 80, prompt_cache_hit_tokens: 0 },
    }), { headers: { "Content-Type": "application/json" } })
  }

  const { runOrchestration } = await import("../lib/server/orchestrator")
  const events: RunEvent[] = []
  const audit: OrchestrationAuditEvent[] = []
  await runOrchestration({
    body: {
      message: "Ověř selhání specialisty.",
      mode: "universal",
      depth: "full",
      model: "deepseek-flash",
      reasoning: false,
      enabledAgents: [...SPECIALISTS],
      budget: { maxTokens: 500_000, maxCostUsd: 5 },
      memories: [],
    },
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    limits: { maxTokens: 500_000, maxCostUsd: 5 },
    audit: async (event) => { audit.push(event) },
  })

  assert.equal(calls.filter((role) => role === "RESEARCHER").length, 1)
  assert.ok(events.some((event) => event.type === "agent_error" && event.agent === "researcher"))
  assert.ok(events.some((event) => event.type === "agent_status" && event.agent === "researcher" && event.status === "error"))
  for (const agent of SPECIALISTS.filter((id) => id !== "researcher")) {
    assert.ok(events.some((event) => event.type === "agent_output" && event.agent === agent), `${agent} output missing`)
    assert.ok(events.some((event) => event.type === "agent_status" && event.agent === agent && event.status === "done"), `${agent} did not finish`)
  }
  assert.ok(calls.includes("FINAL JUDGE"))
  const terminal = audit.filter((event) => event.event === "run_failed" || event.event === "run_completed")
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0]?.event, "run_failed")
  assert.equal(terminal[0]?.event === "run_failed" && terminal[0].failureReason, "model_error")
  assert.equal(audit.at(-1)?.event, "run_failed")
  assert.ok(!events.some((event) => event.type === "final"))
  assert.ok(events.some((event) => event.type === "error"))
  assert.equal(events.at(-1)?.type, "done")
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

test("legacy ciphertext can be re-encrypted with the current key", () => {
  const plaintext = "historical encrypted memory"
  process.env.JARVIS_ENCRYPTION_KEY = "historical-test-encryption-key-1234567890"
  delete process.env.JARVIS_LEGACY_ENCRYPTION_KEY
  const historicalCiphertext = encryptText(plaintext)

  process.env.JARVIS_ENCRYPTION_KEY = "rotated-test-encryption-key-1234567890"
  process.env.JARVIS_LEGACY_ENCRYPTION_KEY = "historical-test-encryption-key-1234567890"
  const recovered = decryptText(historicalCiphertext)
  assert.equal(recovered, plaintext)

  const rotatedCiphertext = encryptText(recovered)
  assert.notEqual(rotatedCiphertext, historicalCiphertext)
  delete process.env.JARVIS_LEGACY_ENCRYPTION_KEY
  assert.equal(decryptText(rotatedCiphertext), plaintext)
  assert.notEqual(decryptText(historicalCiphertext), plaintext)
})
