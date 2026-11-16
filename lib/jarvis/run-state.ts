import { AGENT_ORDER } from "./agents"
import { emptyUsage } from "./pricing"
import type { AgentId, AgentOutput, AgentStatus, FinalAnswer, RunEvent, SpecialistId, Usage } from "./types"

export interface AgentRuntime {
  status: AgentStatus
  task: string
  activity: string
  output?: AgentOutput
  usage?: Usage
  error?: string
  durationMs?: number
  attempts?: number
  updatedAt: number
}

export interface RunState {
  phase: "idle" | "running" | "done" | "error"
  source: "live" | "demo" | null
  prompt: string
  agents: Record<AgentId, AgentRuntime>
  links: { from: AgentId; to: AgentId; at: number }[]
  plan: { agent: SpecialistId; task: string }[]
  rationale: string
  memoryMatches: { id: string; title: string; score: number }[]
  usage: Usage
  budget: { maxTokens: number; maxCostUsd: number } | null
  notices: string[]
  final: FinalAnswer | null
  error: string | null
  durationMs: number | null
}

function idleAgents(): Record<AgentId, AgentRuntime> {
  return Object.fromEntries(
    AGENT_ORDER.map((id) => [id, { status: "idle", task: "Čeká na zadání", activity: "Připraven", updatedAt: 0 }]),
  ) as Record<AgentId, AgentRuntime>
}

export const initialRunState: RunState = {
  phase: "idle",
  source: null,
  prompt: "",
  agents: idleAgents(),
  links: [],
  plan: [],
  rationale: "",
  memoryMatches: [],
  usage: emptyUsage(),
  budget: null,
  notices: [],
  final: null,
  error: null,
  durationMs: null,
}

export type RunAction =
  | { type: "start"; source: "live" | "demo"; prompt: string }
  | { type: "event"; event: RunEvent }
  | { type: "fail"; message: string }
  | { type: "cancelled" }
  | { type: "reset" }

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "start":
      return { ...initialRunState, agents: idleAgents(), phase: "running", source: action.source, prompt: action.prompt }
    case "reset":
      return { ...initialRunState, agents: idleAgents() }
    case "fail":
      return { ...state, phase: "error", error: action.message }
    case "cancelled": {
      const agents = { ...state.agents }
      for (const id of AGENT_ORDER) {
        if (agents[id].status === "thinking" || agents[id].status === "queued") {
          agents[id] = { ...agents[id], status: "skipped", activity: "Zrušeno uživatelem", updatedAt: Date.now() }
        }
      }
      return { ...state, agents, phase: state.final ? "done" : "error", error: state.final ? null : "Běh byl zrušen." }
    }
    case "event":
      return applyEvent(state, action.event)
  }
}

function applyEvent(state: RunState, e: RunEvent): RunState {
  switch (e.type) {
    case "run_start":
      return state
    case "agent_status":
      return {
        ...state,
        agents: {
          ...state.agents,
          [e.agent]: { ...state.agents[e.agent], status: e.status, task: e.task, activity: e.activity, updatedAt: e.at },
        },
      }
    case "plan":
      return { ...state, plan: e.selected, rationale: e.rationale }
    case "memory_context":
      return { ...state, memoryMatches: e.matched }
    case "agent_output":
      return {
        ...state,
        agents: {
          ...state.agents,
          [e.agent]: {
            ...state.agents[e.agent],
            output: e.output,
            usage: e.usage,
            durationMs: e.durationMs,
            attempts: e.attempts,
            updatedAt: e.at,
          },
        },
      }
    case "agent_error":
      return {
        ...state,
        agents: { ...state.agents, [e.agent]: { ...state.agents[e.agent], error: e.message, attempts: e.attempts } },
        notices: [...state.notices, `${e.message}`],
      }
    case "link":
      if (state.links.some((l) => l.from === e.from && l.to === e.to)) return state
      return { ...state, links: [...state.links, { from: e.from, to: e.to, at: e.at }] }
    case "usage":
      return { ...state, usage: e.total, budget: e.budget }
    case "budget_stop":
      return { ...state, notices: [...state.notices, e.reason] }
    case "final":
      return { ...state, final: e.result }
    case "error":
      return { ...state, error: e.message }
    case "done":
      return {
        ...state,
        phase: state.final ? "done" : "error",
        error: state.final ? state.error : (state.error ?? "Běh skončil bez výsledku."),
        durationMs: e.durationMs,
      }
  }
}
