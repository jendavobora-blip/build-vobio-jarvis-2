import type { AgentId, SpecialistId, WorkMode } from "./types"

export interface AgentDefinition {
  id: AgentId
  name: string
  role: string
  color: string
  /** Canvas slot position in percent of the canvas box (card top-left). */
  slot: { x: number; y: number }
}

export const AGENTS: Record<AgentId, AgentDefinition> = {
  orchestrator: {
    id: "orchestrator",
    name: "Orchestrátor",
    role: "Koordinuje úkoly a syntetizuje výsledky",
    color: "#22d3ee",
    slot: { x: 27, y: 2 },
  },
  researcher: {
    id: "researcher",
    name: "Výzkumník",
    role: "Zkoumá zdroje a shromažďuje informace",
    color: "#60a5fa",
    slot: { x: 2, y: 22 },
  },
  memory: {
    id: "memory",
    name: "Strážce paměti",
    role: "Vybírá relevantní kontext z uložené paměti",
    color: "#a78bfa",
    slot: { x: 52, y: 22 },
  },
  planner: {
    id: "planner",
    name: "Plánovač",
    role: "Rozkládá cíle na proveditelné kroky",
    color: "#34d399",
    slot: { x: 2, y: 44 },
  },
  analyst: {
    id: "analyst",
    name: "Analytik",
    role: "Počítá, porovnává scénáře a hodnotí rizika",
    color: "#fbbf24",
    slot: { x: 52, y: 44 },
  },
  creator: {
    id: "creator",
    name: "Tvůrce",
    role: "Píše obsah, návrhy kódu a české výstupy",
    color: "#f472b6",
    slot: { x: 2, y: 66 },
  },
  auditor: {
    id: "auditor",
    name: "Auditor",
    role: "Kontroluje důkazy, rozpory a kvalitu",
    color: "#fb7185",
    slot: { x: 52, y: 66 },
  },
}

export const AGENT_ORDER: AgentId[] = [
  "orchestrator",
  "researcher",
  "memory",
  "planner",
  "analyst",
  "creator",
  "auditor",
]

export const SPECIALISTS: SpecialistId[] = [
  "researcher",
  "memory",
  "planner",
  "analyst",
  "creator",
  "auditor",
]

export const MODE_LABELS: Record<WorkMode, { label: string; hint: string }> = {
  universal: {
    label: "Univerzální",
    hint: "Otázky, výzkum, psaní, kód a produktivita",
  },
  investments: {
    label: "Investice",
    hint: "Krypto, scénáře, rizika a historická srovnání",
  },
  business: {
    label: "Byznys",
    hint: "Příležitosti, náklady, marketing a strategie",
  },
}

export const QUICK_MAX_SPECIALISTS = 3
