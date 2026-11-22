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
    name: "Router",
    role: "Vyhodnocuje zadání a vybírá oprávněné specialisty",
    color: "#22d3ee",
    slot: { x: 2, y: 2 },
  },
  researcher: {
    id: "researcher",
    name: "Researcher",
    role: "Zkoumá zdroje a shromažďuje informace",
    color: "#60a5fa",
    slot: { x: 52, y: 2 },
  },
  memory: {
    id: "memory",
    name: "Strážce paměti",
    role: "Vybírá relevantní kontext z uložené paměti",
    color: "#a78bfa",
    slot: { x: 2, y: 26 },
  },
  planner: {
    id: "planner",
    name: "Architect",
    role: "Navrhuje systémy a architekturu",
    color: "#34d399",
    slot: { x: 52, y: 26 },
  },
  analyst: {
    id: "analyst",
    name: "Analyst",
    role: "Počítá, porovnává scénáře a hodnotí rizika",
    color: "#fbbf24",
    slot: { x: 2, y: 50 },
  },
  creator: {
    id: "creator",
    name: "Coder",
    role: "Připravuje kód a technickou implementaci",
    color: "#f472b6",
    slot: { x: 52, y: 50 },
  },
  auditor: {
    id: "auditor",
    name: "Critic",
    role: "Oponuje výsledkům a odhaluje chyby a rizika",
    color: "#fb7185",
    slot: { x: 2, y: 74 },
  },
  final_judge: {
    id: "final_judge",
    name: "Final Judge",
    role: "Ověřuje závěry a připravuje finální syntézu",
    color: "#c084fc",
    slot: { x: 52, y: 74 },
  },
}

export const LEGACY_AGENT_ORDER: AgentId[] = [
  "orchestrator",
  "researcher",
  "memory",
  "planner",
  "analyst",
  "creator",
  "auditor",
]

export const AGENT_ORDER: AgentId[] = [
  "orchestrator",
  "researcher",
  "memory",
  "planner",
  "analyst",
  "creator",
  "auditor",
  "final_judge",
]

export const TARGET_AGENT_ROLES = [
  "router",
  "researcher",
  "architect",
  "coder",
  "analyst",
  "critic",
  "final_judge",
] as const

export type TargetAgentRole = (typeof TARGET_AGENT_ROLES)[number]

export const TARGET_ROLE_TO_AGENT: Record<TargetAgentRole, AgentId> = {
  router: "orchestrator",
  researcher: "researcher",
  architect: "planner",
  coder: "creator",
  analyst: "analyst",
  critic: "auditor",
  final_judge: "final_judge",
}

export const LEGACY_ROLE_TO_TARGET: Partial<Record<AgentId, TargetAgentRole>> = {
  orchestrator: "router",
  researcher: "researcher",
  planner: "architect",
  creator: "coder",
  analyst: "analyst",
  auditor: "critic",
  final_judge: "final_judge",
}

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
