import type { AgentId, AgentOutput, RunEvent, SpecialistId } from "./types"

/**
 * Visual-only scripted timeline. Every text is explicitly marked as DEMO and no
 * network request is made. Usage stays at zero so no statistics are invented.
 */
const DEMO_PLAN: { agent: SpecialistId; task: string }[] = [
  { agent: "memory", task: "Najít preference a související projekty" },
  { agent: "researcher", task: "Shrnout klíčové souvislosti tématu" },
  { agent: "planner", task: "Rozložit cíl na kroky" },
  { agent: "analyst", task: "Porovnat tři scénáře" },
  { agent: "creator", task: "Připravit český výstup" },
  { agent: "auditor", task: "Zkontrolovat rozpory a rizika" },
]

function demoOutput(title: string, points: string[], data: { label: string; value: string }[] = []): AgentOutput {
  return {
    summary: `[DEMO] ${title}`,
    points: points.map((p) => `[DEMO] ${p}`),
    data,
    confidence: "střední",
    warnings: ["Ukázková data – nejde o skutečnou práci agenta."],
  }
}

const DEMO_OUTPUTS: Record<SpecialistId, AgentOutput> = {
  memory: demoOutput("Ukázka výběru kontextu z paměti.", ["Preferovaný jazyk: čeština", "Související projekt: VOBIO"]),
  researcher: demoOutput("Ukázka rešerše bez přístupu k webu.", ["Fakta by zde byla ověřena", "Zdroje k ověření by byly uvedeny"]),
  planner: demoOutput("Ukázka plánu ve třech fázích.", ["Fáze 1: Příprava", "Fáze 2: Realizace", "Fáze 3: Vyhodnocení"]),
  analyst: demoOutput(
    "Ukázka srovnání scénářů.",
    ["Scénáře jsou ilustrativní"],
    [
      { label: "Pesimistický", value: "ukázka" },
      { label: "Realistický", value: "ukázka" },
      { label: "Optimistický", value: "ukázka" },
    ],
  ),
  creator: demoOutput("Ukázka návrhu textu.", ["Struktura dokumentu", "Návrh úvodního odstavce"]),
  auditor: demoOutput("Ukázka auditu kvality.", ["Žádná skutečná kontrola neproběhla"]),
}

export function buildDemoTimeline(): { delay: number; event: RunEvent }[] {
  const t: { delay: number; event: RunEvent }[] = []
  let clock = 0
  const at = () => Date.now()
  const push = (delay: number, event: RunEvent) => {
    clock += delay
    t.push({ delay: clock, event })
  }
  const status = (agent: AgentId, s: "queued" | "thinking" | "done" | "skipped", task: string, activity: string) =>
    ({ type: "agent_status", agent, status: s, task, activity: `[DEMO] ${activity}`, at: at() }) as RunEvent

  push(100, { type: "run_start", runId: "demo", model: "deepseek-flash", depth: "full", at: at() })
  push(200, status("orchestrator", "thinking", "Sestavení týmu", "Simuluji výběr specialistů"))
  push(1400, { type: "plan", selected: DEMO_PLAN, rationale: "[DEMO] Ukázkový výběr celého týmu.", at: at() })
  for (const p of DEMO_PLAN) {
    push(120, status(p.agent, "queued", p.task, "Čeká na spuštění"))
    push(0, { type: "link", from: "orchestrator", to: p.agent, at: at() })
  }
  push(200, status("orchestrator", "queued", "Koordinace týmu", "Deleguji úkoly"))

  const phase1: SpecialistId[] = ["memory", "researcher", "planner", "analyst"]
  for (const id of phase1) push(250, status(id, "thinking", DEMO_PLAN.find((p) => p.agent === id)!.task, "Simulovaná práce"))
  for (const id of phase1) {
    push(900, { type: "agent_output", agent: id, output: DEMO_OUTPUTS[id], usage: zero(), durationMs: 0, attempts: 0, at: at() })
    push(0, status(id, "done", DEMO_PLAN.find((p) => p.agent === id)!.task, "Hotovo"))
  }
  for (const id of phase1) push(80, { type: "link", from: id, to: "creator", at: at() })
  push(200, status("creator", "thinking", "Připravit český výstup", "Simulované psaní"))
  push(1400, { type: "agent_output", agent: "creator", output: DEMO_OUTPUTS.creator, usage: zero(), durationMs: 0, attempts: 0, at: at() })
  push(0, status("creator", "done", "Připravit český výstup", "Hotovo"))
  push(150, { type: "link", from: "creator", to: "auditor", at: at() })
  push(200, status("auditor", "thinking", "Zkontrolovat rozpory a rizika", "Simulovaná kontrola"))
  push(1300, { type: "agent_output", agent: "auditor", output: DEMO_OUTPUTS.auditor, usage: zero(), durationMs: 0, attempts: 0, at: at() })
  push(0, status("auditor", "done", "Zkontrolovat rozpory a rizika", "Hotovo"))
  for (const p of DEMO_PLAN) push(60, { type: "link", from: p.agent, to: "orchestrator", at: at() })
  push(200, status("orchestrator", "thinking", "Syntéza výsledků", "Simulovaná syntéza"))
  push(1400, {
    type: "final",
    result: {
      answer:
        "## DEMO REŽIM\n\nToto je **ukázková vizualizace** spolupráce agentů. Neproběhlo žádné volání API a žádný agent nevykonal skutečnou práci.\n\n- Pro živý režim nastavte `DEEPSEEK_API_KEY` a `JARVIS_ACCESS_CODE`\n- Poté se přihlaste v Nastavení a přepněte na živý režim",
      nextSteps: ["Nastavit proměnné prostředí ve Vercelu", "Přihlásit se přístupovým kódem"],
      needsApproval: [],
    },
    at: at(),
  })
  push(0, status("orchestrator", "done", "Syntéza výsledků", "Hotovo"))
  push(100, { type: "done", durationMs: clock, at: at() })
  return t
}

function zero() {
  return { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 }
}
