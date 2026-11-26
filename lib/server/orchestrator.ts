import "server-only"
import { z } from "zod"
import { callChat, callChatJson, callJson, DeepSeekError, MAX_ATTEMPTS, type ChatMessage } from "./deepseek"
import { plannerSystem, specialistSystem, synthesisSystem } from "./prompts"
import { executeSearchMemory, SEARCH_MEMORY_TOOL, TOOL_NAME, ToolError } from "./tools"
import { AGENTS, QUICK_MAX_SPECIALISTS, SPECIALISTS } from "@/lib/jarvis/agents"
import { addUsage, emptyUsage, worstCaseCost } from "@/lib/jarvis/pricing"
import { retrieveMemories } from "@/lib/jarvis/retrieval"
import type {
  AgentId,
  AgentOutput,
  ChatRequestBody,
  FinalAnswer,
  ModelId,
  RunEvent,
  SpecialistId,
  Usage,
} from "@/lib/jarvis/types"

const trimmed = (max: number) => z.string().transform((s) => s.trim().slice(0, max))

const agentOutputSchema = z.object({
  summary: trimmed(800),
  points: z.array(trimmed(600)).max(12).catch([]).transform((p) => p.filter(Boolean).slice(0, 6)),
  data: z
    .array(z.object({ label: trimmed(80), value: z.coerce.string().transform((s) => s.slice(0, 200)) }))
    .max(12)
    .catch([])
    .transform((d) => d.slice(0, 6)),
  confidence: z.enum(["nízká", "střední", "vysoká"]).catch("střední"),
  warnings: z.array(trimmed(300)).max(8).catch([]),
})

const planSchema = z.object({
  rationale: trimmed(300).catch(""),
  agents: z.array(z.object({ id: z.string(), task: trimmed(300) })).max(10),
})

const finalSchema = z.object({
  answer: z.string().transform((s) => s.trim().slice(0, 12_000)),
  nextSteps: z.array(trimmed(300)).max(10).catch([]),
  needsApproval: z.array(trimmed(300)).max(10).catch([]),
})

const memoryToolContextSchema = z.object({ context: z.string().optional() })

type Emit = (event: RunEvent) => void

interface RunContext {
  body: ChatRequestBody
  emit: Emit
  signal: AbortSignal
  limits: { maxTokens: number; maxCostUsd: number }
}

const now = () => Date.now()

function maxTokensFor(body: ChatRequestBody, kind: "plan" | "specialist" | "final"): number {
  const base = kind === "plan" ? 500 : kind === "specialist" ? 1100 : 1800
  return body.reasoning ? base + 2500 : base
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3) + 50
}

function formatOutputs(outputs: Partial<Record<AgentId, AgentOutput>>): string {
  return Object.entries(outputs)
    .map(([id, out]) => {
      if (!out) return ""
      const name = AGENTS[id as AgentId].name
      const data = out.data.map((d) => `${d.label}: ${d.value}`).join("; ")
      return `### ${name}\nShrnutí: ${out.summary}\nBody:\n- ${out.points.join("\n- ")}${data ? `\nData: ${data}` : ""}${
        out.warnings.length ? `\nUpozornění: ${out.warnings.join("; ")}` : ""
      }\nDůvěra: ${out.confidence}`
    })
    .filter(Boolean)
    .join("\n\n")
}

function fallbackSelection(body: ChatRequestBody, limit: number): { agent: SpecialistId; task: string }[] {
  const priority: SpecialistId[] =
    body.mode === "investments"
      ? ["analyst", "researcher", "auditor", "memory", "planner", "creator"]
      : body.mode === "business"
        ? ["planner", "analyst", "researcher", "creator", "auditor", "memory"]
        : ["researcher", "creator", "planner", "analyst", "auditor", "memory"]
  return priority
    .filter((id) => body.enabledAgents.includes(id))
    .slice(0, limit)
    .map((agent) => ({ agent, task: `${AGENTS[agent].role} pro zadaný úkol.` }))
}

export async function runOrchestration({ body, emit, signal, limits }: RunContext): Promise<Usage> {
  let total = emptyUsage()
  const start = now()
  const runId = crypto.randomUUID()
  let budgetStopped = false

  let inFlightTokens = 0
  let inFlightCost = 0
  const reserveCallBudget = (promptText: string, maxOut: number, model: ModelId = body.model): (() => void) | undefined => {
    const promptTokens = estimateTokens(promptText)
    const tokens = (promptTokens + maxOut) * MAX_ATTEMPTS
    const cost = worstCaseCost(model, promptTokens, maxOut) * MAX_ATTEMPTS
    if (
      total.promptTokens + total.completionTokens + inFlightTokens + tokens > limits.maxTokens ||
      total.costUsd + inFlightCost + cost > limits.maxCostUsd
    ) {
      return undefined
    }
    inFlightTokens += tokens
    inFlightCost += cost
    let released = false
    return () => {
      if (released) return
      released = true
      inFlightTokens -= tokens
      inFlightCost -= cost
    }
  }

  const track = (usage: Usage) => {
    total = addUsage(total, usage)
    emit({ type: "usage", total, budget: limits, at: now() })
  }

  emit({ type: "run_start", runId, model: body.model, depth: body.depth, at: now() })

  /* 1. Memory retrieval (local, free) */
  const matches = retrieveMemories(body.message, body.memories, body.mode)
  emit({
    type: "memory_context",
    matched: matches.map((m) => ({ id: m.item.id, title: m.item.title, score: m.score })),
    at: now(),
  })
  const memoryContext = matches.length
    ? matches.map((m) => `- [${m.item.category}] ${m.item.title}: ${m.item.content.slice(0, 600)}`).join("\n")
    : "(žádné relevantní položky paměti)"

  /* 1b. Single fixed read-only tool round over the request's own memories (deepseek-flash). */
  const toolModel: ModelId = "deepseek-flash"
  const runMemoryTool = async (): Promise<string> => {
    if (body.memories.length === 0) return ""

    const system =
      "Jsi paměťový vyhledávač VOBIO JARVIS. Máš k dispozici jediný nástroj search_memory, který prohledá POUZE paměťové položky přiložené k tomuto požadavku. Pokud potřebuješ doplnit kontext, zavolej nástroj search_memory nejvýše v jednom kole. Nevymýšlej data, která v paměti nejsou."
    const user = `Zadání uživatele:\n${body.message}\n\nPokud je to užitečné, vyhledej relevantní položky v paměti nástrojem search_memory. Poté vrať JSON ve tvaru {"context": "stručné shrnutí nebo prázdný řetězec"}.`

    emit({
      type: "agent_status",
      agent: "memory",
      status: "thinking",
      task: "Tool: search_memory",
      activity: "Zvažuji vyhledání v paměti",
      at: now(),
    })

    const reserveFirst = reserveCallBudget(system + user, 500, toolModel)
    if (!reserveFirst) {
      budgetStopped = true
      emit({ type: "budget_stop", reason: "Nástroj search_memory přeskočen – byl by překročen limit požadavku.", at: now() })
      return ""
    }

    let first: Awaited<ReturnType<typeof callChat>>
    try {
      first = await callChat({
        model: toolModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        maxTokens: 500,
        reasoning: false,
        jsonMode: false,
        tools: [SEARCH_MEMORY_TOOL],
        toolChoice: "auto",
        signal,
      })
      track(first.usage)
    } catch (error) {
      const usage = (error as { usage?: Usage }).usage
      if (usage) track(usage)
      const message = error instanceof DeepSeekError ? error.message : "Volání nástroje selhalo."
      emit({
        type: "agent_error",
        agent: "memory",
        message,
        attempts: (error as { attempts?: number }).attempts ?? 1,
        at: now(),
      })
      if (error instanceof DeepSeekError && error.fatal) {
        Object.assign(error, { usage: total })
        throw error
      }
      return ""
    } finally {
      reserveFirst()
    }

    if (!first.toolCalls.length) {
      emit({
        type: "agent_status",
        agent: "memory",
        status: "done",
        task: "Tool: search_memory",
        activity: "Nástroj nebyl potřeba",
        at: now(),
      })
      return ""
    }

    const assistantMessage: ChatMessage = { role: "assistant", content: first.content, tool_calls: first.toolCalls }
    const toolMessages: ChatMessage[] = []
    let toolFailed = false
    let matchCount = 0

    // One tool round only: every tool_call in this first response is validated and
    // executed here; the follow-up call cannot request further tool execution.
    for (const call of first.toolCalls) {
      const fn = (call as { function?: { name?: string; arguments?: string } }).function
      if (!fn || fn.name !== TOOL_NAME) {
        toolFailed = true
        const message = `Neznámý nástroj: ${fn?.name ?? "?"}`
        emit({ type: "agent_error", agent: "memory", message, attempts: 1, at: now() })
        toolMessages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: message }) })
        continue
      }
      try {
        const outcome = executeSearchMemory(body.memories, fn.arguments ?? "")
        matchCount += outcome.matches
        emit({
          type: "agent_status",
          agent: "memory",
          status: "thinking",
          task: "Tool: search_memory",
          activity: `search_memory: ${outcome.matches} výsledků`,
          at: now(),
        })
        toolMessages.push({ role: "tool", tool_call_id: call.id, content: outcome.content })
      } catch (error) {
        toolFailed = true
        const message = error instanceof ToolError ? error.message : "Nástroj selhal."
        emit({ type: "agent_error", agent: "memory", message, attempts: 1, at: now() })
        toolMessages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: message }) })
      }
    }

    const finalUser = `${user}\n\nNyní vrať pouze JSON ve tvaru {"context": "..."} – nástroj už znovu nevolat.`
    const finalMessages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
      assistantMessage,
      ...toolMessages,
    ]
    const reserveSecond = reserveCallBudget(system + finalUser + JSON.stringify(toolMessages), 500, toolModel)
    if (!reserveSecond) {
      budgetStopped = true
      emit({
        type: "budget_stop",
        reason: "Dokončení nástroje search_memory přeskočeno – byl by překročen limit požadavku.",
        at: now(),
      })
      return ""
    }

    try {
      const contextResult = await callChatJson(
        {
          model: toolModel,
          messages: finalMessages,
          maxTokens: 500,
          reasoning: false,
          jsonMode: true,
          tools: [SEARCH_MEMORY_TOOL],
          toolChoice: "none",
          signal,
        },
        (value) => memoryToolContextSchema.parse(value),
      )
      track(contextResult.usage)
      if (toolFailed) {
        emit({
          type: "agent_status",
          agent: "memory",
          status: "done",
          task: "Tool: search_memory",
          activity: "Nástroj selhal",
          at: now(),
        })
        return ""
      }
      const context = (contextResult.data.context ?? "").trim().slice(0, 800)
      emit({
        type: "agent_status",
        agent: "memory",
        status: "done",
        task: "Tool: search_memory",
        activity: context ? `Tool dokončen: ${matchCount} výsledků` : "Tool dokončen: bez výsledků",
        at: now(),
      })
      return context
    } catch (error) {
      const usage = (error as { usage?: Usage }).usage
      if (usage && usage.promptTokens) track(usage)
      const message = error instanceof DeepSeekError ? error.message : "Dokončení nástroje selhalo."
      emit({
        type: "agent_error",
        agent: "memory",
        message,
        attempts: (error as { attempts?: number }).attempts ?? 1,
        at: now(),
      })
      if (error instanceof DeepSeekError && error.fatal) {
        Object.assign(error, { usage: total })
        throw error
      }
      return ""
    } finally {
      reserveSecond()
    }
  }

  const toolContext = await runMemoryTool()
  const enrichedMemoryContext = toolContext
    ? `${memoryContext}\n\nDoplněno nástrojem search_memory:\n${toolContext}`
    : memoryContext

  /* 2. Orchestrator plans the team */
  const limit = body.depth === "quick" ? QUICK_MAX_SPECIALISTS : SPECIALISTS.length
  const available = body.enabledAgents.map((id) => `${id} (${AGENTS[id].name}: ${AGENTS[id].role})`).join(", ")
  let selected: { agent: SpecialistId; task: string }[] = []
  let rationale = ""

  emit({
    type: "agent_status",
    agent: "orchestrator",
    status: "thinking",
    task: "Sestavení týmu",
    activity: "Analyzuji zadání a vybírám specialisty",
    at: now(),
  })

  if (body.depth === "full") {
    selected = body.enabledAgents.map((agent) => ({ agent, task: "" }))
  }

  const planUser = `Úkol uživatele:\n${body.message}\n\n${
    body.depth === "full"
      ? `Režim celého týmu: zadej konkrétní úkol KAŽDÉMU z dostupných specialistů.`
      : `Rychlý režim: vyber nejvýše ${limit} specialistů.`
  }`
  const planSys = plannerSystem(body.mode, available, limit)
  const planMax = maxTokensFor(body, "plan")
  const planReservation = body.enabledAgents.length ? reserveCallBudget(planSys + planUser, planMax) : undefined

  if (body.enabledAgents.length === 0) {
    rationale = "Všichni specialisté jsou vypnutí v nastavení – odpovídá pouze orchestrátor."
  } else if (planReservation) {
    try {
      const plan = await callJson(
        { model: body.model, system: planSys, user: planUser, maxTokens: planMax, reasoning: body.reasoning, signal },
        (v) => planSchema.parse(v),
      )
      track(plan.usage)
      rationale = plan.data.rationale
      const tasks = new Map<SpecialistId, string>()
      for (const a of plan.data.agents) {
        if ((body.enabledAgents as string[]).includes(a.id)) tasks.set(a.id as SpecialistId, a.task)
      }
      if (body.depth === "full") {
        selected = selected.map((s) => ({ ...s, task: tasks.get(s.agent) || `${AGENTS[s.agent].role} pro zadaný úkol.` }))
      } else {
        selected = [...tasks.entries()].slice(0, limit).map(([agent, task]) => ({ agent, task }))
      }
    } catch (error) {
      const usage = (error as { usage?: Usage }).usage
      if (usage) track(usage)
      if (error instanceof DeepSeekError && error.fatal) {
        emit({ type: "agent_error", agent: "orchestrator", message: error.message, attempts: (error as { attempts?: number }).attempts ?? 1, at: now() })
        Object.assign(error, { usage: total })
        throw error
      }
      rationale = "Plánování modelem selhalo – použit záložní výběr podle pracovního režimu."
    } finally {
      planReservation()
    }
  } else {
    rationale = "Rozpočet nestačí na plánovací krok – použit záložní výběr."
  }

  if (selected.length === 0 && body.enabledAgents.length > 0) selected = fallbackSelection(body, limit)
  selected = selected.map((s) => ({ ...s, task: s.task || `${AGENTS[s.agent].role} pro zadaný úkol.` }))

  emit({ type: "plan", selected, rationale, at: now() })
  emit({
    type: "agent_status",
    agent: "orchestrator",
    status: "queued",
    task: "Koordinace týmu",
    activity: `Deleguji na ${selected.length} specialist${selected.length === 1 ? "u" : "y"}`,
    at: now(),
  })

  for (const id of SPECIALISTS) {
    const sel = selected.find((s) => s.agent === id)
    emit({
      type: "agent_status",
      agent: id,
      status: sel ? "queued" : "skipped",
      task: sel?.task ?? "Nevybrán pro tento úkol",
      activity: sel ? "Čeká na spuštění" : "Neaktivní",
      at: now(),
    })
    if (sel) emit({ type: "link", from: "orchestrator", to: id, at: now() })
  }

  /* 3. Specialists in dependency phases */
  const outputs: Partial<Record<AgentId, AgentOutput>> = {}

  const runSpecialist = async (agent: SpecialistId, task: string, upstream: AgentId[]) => {
    if (signal.aborted) return
    const system = specialistSystem(agent, body.mode)
    const prior = upstream.filter((id) => outputs[id])
    const user = `Úkol uživatele:\n${body.message}\n\nTvůj dílčí úkol: ${task}\n\nKontext z paměti uživatele:\n${enrichedMemoryContext}${
      prior.length ? `\n\nVýstupy ostatních agentů:\n${formatOutputs(Object.fromEntries(prior.map((id) => [id, outputs[id]])))}` : ""
    }`
    const maxOut = maxTokensFor(body, "specialist")
    const reservation = reserveCallBudget(system + user, maxOut)

    if (!reservation) {
      budgetStopped = true
      emit({ type: "budget_stop", reason: `${AGENTS[agent].name} přeskočen – byl by překročen limit požadavku.`, at: now() })
      emit({ type: "agent_status", agent, status: "skipped", task, activity: "Přeskočeno kvůli rozpočtu", at: now() })
      return
    }

    for (const from of prior) emit({ type: "link", from, to: agent, at: now() })
    emit({
      type: "agent_status",
      agent,
      status: "thinking",
      task,
      activity: prior.length ? `Zpracovávám výstupy: ${prior.map((p) => AGENTS[p].name).join(", ")}` : "Volám DeepSeek",
      at: now(),
    })
    const t0 = now()
    try {
      const result = await callJson(
        { model: body.model, system, user, maxTokens: maxOut, reasoning: body.reasoning, signal },
        (v) => agentOutputSchema.parse(v) as AgentOutput,
      )
      track(result.usage)
      outputs[agent] = result.data
      emit({
        type: "agent_output",
        agent,
        output: result.data,
        usage: result.usage,
        durationMs: now() - t0,
        attempts: result.attempts,
        at: now(),
      })
      emit({ type: "agent_status", agent, status: "done", task, activity: "Hotovo", at: now() })
    } catch (error) {
      const usage = (error as { usage?: Usage }).usage
      if (usage && usage.promptTokens) track(usage)
      const message = error instanceof DeepSeekError ? error.message : "Agent selhal."
      emit({ type: "agent_error", agent, message, attempts: (error as { attempts?: number }).attempts ?? 1, at: now() })
      emit({ type: "agent_status", agent, status: "error", task, activity: message, at: now() })
      if (error instanceof DeepSeekError && error.fatal) {
        Object.assign(error, { usage: total })
        throw error
      }
    } finally {
      reservation()
    }
  }

  const phase = (ids: SpecialistId[]) => selected.filter((s) => ids.includes(s.agent))
  const phases: { members: { agent: SpecialistId; task: string }[]; upstream: AgentId[] }[] = [
    { members: phase(["memory", "researcher", "planner", "analyst"]), upstream: [] },
    { members: phase(["creator"]), upstream: ["memory", "researcher", "planner", "analyst"] },
    { members: phase(["auditor"]), upstream: ["memory", "researcher", "planner", "analyst", "creator"] },
  ]

  for (const p of phases) {
    if (signal.aborted) break
    await Promise.all(p.members.map((m) => runSpecialist(m.agent, m.task, p.upstream)))
  }

  /* 4. Synthesis */
  if (!signal.aborted) {
    const done = Object.keys(outputs) as AgentId[]
    for (const id of done) emit({ type: "link", from: id, to: "final_judge", at: now() })
    emit({
      type: "agent_status",
      agent: "final_judge",
      status: "thinking",
      task: "Syntéza výsledků",
      activity: done.length ? `Nezávisle posuzuji ${done.length} výstup${done.length === 1 ? "" : "y"}` : "Kontroluji přímou odpověď",
      at: now(),
    })
    const system = synthesisSystem(body.mode)
    const user = `Úkol uživatele:\n${body.message}\n\nKontext z paměti:\n${enrichedMemoryContext}\n\nVýstupy specialistů:\n${
      formatOutputs(outputs) || "(žádné – odpověz sám a stručně)"
    }`
    const maxOut = maxTokensFor(body, "final")
    let result: FinalAnswer | undefined
    const finalReservation = reserveCallBudget(system + user, maxOut)

    if (finalReservation) {
      try {
        const synth = await callJson(
          { model: body.model, system, user, maxTokens: maxOut, reasoning: body.reasoning, signal },
          (v) => finalSchema.parse(v),
        )
        track(synth.usage)
        result = synth.data
        emit({ type: "agent_status", agent: "final_judge", status: "done", task: "Finální kontrola", activity: "Odpověď připravena", at: now() })
      } catch (error) {
        const usage = (error as { usage?: Usage }).usage
        if (usage && usage.promptTokens) track(usage)
        const message = error instanceof DeepSeekError ? error.message : "Syntéza selhala."
        emit({ type: "agent_error", agent: "final_judge", message, attempts: (error as { attempts?: number }).attempts ?? 1, at: now() })
        emit({ type: "agent_status", agent: "final_judge", status: "error", task: "Finální kontrola", activity: message, at: now() })
      } finally {
        finalReservation()
      }
    } else {
      budgetStopped = true
      emit({ type: "budget_stop", reason: "Syntéza přeskočena – byl by překročen limit požadavku.", at: now() })
      emit({ type: "agent_status", agent: "final_judge", status: "skipped", task: "Finální kontrola", activity: "Přeskočeno kvůli rozpočtu", at: now() })
    }

    if (!result && done.length) {
      result = {
        answer: `## Dílčí výsledky (bez finální syntézy)\n\n${done
          .map((id) => `**${AGENTS[id].name}:** ${outputs[id]?.summary}`)
          .join("\n\n")}`,
        nextSteps: [],
        needsApproval: [],
      }
      emit({ type: "agent_status", agent: "final_judge", status: "done", task: "Záložní výstup", activity: "Zobrazeny dílčí výsledky", at: now() })
    }
    if (result) emit({ type: "final", result, at: now() })
    else if (!budgetStopped) emit({ type: "error", message: "Nepodařilo se získat žádný výsledek.", at: now() })
    else emit({ type: "error", message: "Rozpočet požadavku byl vyčerpán dříve, než vznikl výsledek. Zvyšte limit v nastavení.", at: now() })
  }

  emit({ type: "done", durationMs: now() - start, at: now() })
  return total
}
