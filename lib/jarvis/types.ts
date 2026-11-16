export type AgentId =
  | "orchestrator"
  | "researcher"
  | "memory"
  | "planner"
  | "analyst"
  | "creator"
  | "auditor"

export type SpecialistId = Exclude<AgentId, "orchestrator">

export type WorkMode = "universal" | "investments" | "business"
export type AnalysisDepth = "quick" | "full"
export type ModelId = "deepseek-flash" | "deepseek-v4-pro"

export type AgentStatus = "idle" | "queued" | "thinking" | "done" | "error" | "skipped"

export type Confidence = "nízká" | "střední" | "vysoká"

export interface AgentOutput {
  summary: string
  points: string[]
  data: { label: string; value: string }[]
  confidence: Confidence
  warnings: string[]
}

export interface FinalAnswer {
  answer: string
  nextSteps: string[]
  needsApproval: string[]
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
  costUsd: number
}

export type MemoryCategory =
  | "preferences"
  | "projects"
  | "business"
  | "investments"
  | "tasks"
  | "history"

export interface MemoryItem {
  id: string
  category: MemoryCategory
  title: string
  content: string
  sensitive: boolean
  createdAt: string
  updatedAt: string
}

export interface ChatRequestBody {
  message: string
  mode: WorkMode
  depth: AnalysisDepth
  model: ModelId
  reasoning: boolean
  enabledAgents: SpecialistId[]
  budget: { maxTokens: number; maxCostUsd: number }
  memories: Pick<MemoryItem, "id" | "category" | "title" | "content">[]
}

export type RunEvent =
  | { type: "run_start"; runId: string; model: ModelId; depth: AnalysisDepth; at: number }
  | { type: "agent_status"; agent: AgentId; status: AgentStatus; task: string; activity: string; at: number }
  | { type: "plan"; selected: { agent: SpecialistId; task: string }[]; rationale: string; at: number }
  | { type: "memory_context"; matched: { id: string; title: string; score: number }[]; at: number }
  | { type: "agent_output"; agent: AgentId; output: AgentOutput; usage: Usage; durationMs: number; attempts: number; at: number }
  | { type: "agent_error"; agent: AgentId; message: string; attempts: number; at: number }
  | { type: "link"; from: AgentId; to: AgentId; at: number }
  | { type: "usage"; total: Usage; budget: { maxTokens: number; maxCostUsd: number }; at: number }
  | { type: "budget_stop"; reason: string; at: number }
  | { type: "final"; result: FinalAnswer; at: number }
  | { type: "error"; message: string; at: number }
  | { type: "done"; durationMs: number; at: number }

export interface StatusResponse {
  deepseekConfigured: boolean
  authConfigured: boolean
  authenticated: boolean
  databaseConfigured: boolean
  limits: { maxRequestUsd: number; maxRequestTokens: number; dailyBudgetUsd: number; runsPer10Min: number }
  usageToday: { costUsd: number; tokens: number; requests: number; shared: boolean } | null
}
