import "server-only"
import { z } from "zod"
import { callJson, DeepSeekError } from "./deepseek"
import { plannerSystem, specialistSystem, synthesisSystem } from "./prompts"
import { AGENTS, QUICK_MAX_SPECIALISTS, SPECIALISTS } from "@/lib/jarvis/agents"
import { addUsage, emptyUsage, worstCaseCost } from "@/lib/jarvis/pricing"
import { retrieveMemories } from "@/lib/jarvis/retrieval"
import type {
  AgentId,
  AgentOutput,
  ChatRequestBody,
  FinalAnswer,
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

  const withinBudget = (promptText: string, maxOut: number) => {
    const promptTokens = estimateTokens(promptText)
    const projectedTokens = total.promptTokens + total.completionTokens + promptTokens + maxOut
    const projectedCost = total.costUsd + worstCaseCost(body.model, promptTokens, maxOut)
    return projectedTokens <= limits.maxTokens && projectedCost <= limits.maxCostUsd
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

  if (body.enabledAgents.length === 0) {
    rationale = "Všichni specialisté jsou vypnutí v nastavení – odpovídá pouze orchestrátor."
  } else if (withinBudget(planSys + planUser, planMax)) {
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
        throw error
      }
      rationale = "Plánování modelem selhalo – použit záložní výběr podle pracovního režimu."
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
  let budgetStopped = false

  const runSpecialist = async (agent: SpecialistId, task: string, upstream: AgentId[]) => {
    if (signal.aborted) return
    const system = specialistSystem(agent, body.mode)
    const prior = upstream.filter((id) => outputs[id])
    const user = `Úkol uživatele:\n${body.message}\n\nTvůj dílčí úkol: ${task}\n\nKontext z paměti uživatele:\n${memoryContext}${
      prior.length ? `\n\nVýstupy ostatních agentů:\n${formatOutputs(Object.fromEntries(prior.map((id) => [id, outputs[id]])))}` : ""
    }`
    const maxOut = maxTokensFor(body, "specialist")

    if (!withinBudget(system + user, maxOut)) {
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
      if (error instanceof DeepSeekError && error.fatal) throw error
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
    const user = `Úkol uživatele:\n${body.message}\n\nKontext z paměti:\n${memoryContext}\n\nVýstupy specialistů:\n${
      formatOutputs(outputs) || "(žádné – odpověz sám a stručně)"
    }`
    const maxOut = maxTokensFor(body, "final")
    let result: FinalAnswer | undefined

    if (withinBudget(system + user, maxOut)) {
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
