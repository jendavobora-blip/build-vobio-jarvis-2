import type { PublicGitHubRepository } from "@/lib/github/public-repository"

export const DEVELOPMENT_AGENTS = [
  { id: "architect", name: "Project Architect", focus: "Rozsah, návrh a akceptační kritéria" },
  { id: "frontend", name: "Frontend Developer", focus: "Responzivní rozhraní, React, Next.js a 3D" },
  { id: "backend", name: "Backend Developer", focus: "API, databáze a serverová logika" },
  { id: "ai", name: "AI Engineer", focus: "Modely, tool calling a orchestrace" },
  { id: "security", name: "Security Engineer", focus: "Oprávnění, izolace a citlivá data" },
  { id: "qa", name: "QA Engineer", focus: "Regresní, integrační a E2E testy" },
  { id: "devops", name: "DevOps Engineer", focus: "CI, GitHub a bezpečné Vercel Preview" },
  { id: "reviewer", name: "Code Reviewer", focus: "Kontrola diffu, kvality a rizik" },
] as const

export interface DevelopmentPlan {
  repository: string
  task: string
  steps: { agentId: (typeof DEVELOPMENT_AGENTS)[number]["id"]; title: string; deliverable: string }[]
}

export type DevelopmentAgentId = (typeof DEVELOPMENT_AGENTS)[number]["id"]

export type DevelopmentStudioEvent = {
  id: string
  runId: string
  agentId: DevelopmentAgentId | "system"
  event: "run_started" | "agent_started" | "agent_mocked" | "executor_blocked" | "run_blocked"
  detailCode: "mock_only" | "sandbox_not_configured"
  occurredAt: string
}

export interface DevelopmentStudioMockRun {
  id: string
  repository: string
  taskHash: string
  mode: "mock_only"
  status: "blocked"
  plan: DevelopmentPlan
  events: DevelopmentStudioEvent[]
}

export interface DevelopmentAgentProvider {
  readonly mode: "mock" | "live"
  runAgent(input: {
    runId: string
    repository: string
    task: string
    agentId: DevelopmentAgentId
    deliverable: string
  }): Promise<void>
}

export interface IsolatedExecutionRequest {
  runId: string
  repository: string
  taskHash: string
  approvalState: "not_authorized"
}

export interface IsolatedCodeExecutor {
  execute(input: IsolatedExecutionRequest): Promise<{ executed: boolean; reason: "sandbox_not_configured" }>
}

export class MockDevelopmentAgentProvider implements DevelopmentAgentProvider {
  readonly mode = "mock" as const

  async runAgent(): Promise<void> {}
}

export class DisabledIsolatedCodeExecutor implements IsolatedCodeExecutor {
  async execute(): Promise<{ executed: boolean; reason: "sandbox_not_configured" }> {
    return { executed: false, reason: "sandbox_not_configured" }
  }
}

export async function createMockDevelopmentStudioRun(input: {
  id: string
  repository: string
  task: string
  taskHash: string
  now?: () => Date
  provider?: DevelopmentAgentProvider
  executor?: IsolatedCodeExecutor
}): Promise<DevelopmentStudioMockRun> {
  const [owner, name, extra] = input.repository.split("/")
  if (!owner || !name || extra) throw new Error("Zadejte platný veřejný repozitář.")
  if (!/^[a-f0-9]{64}$/.test(input.taskHash)) throw new Error("Neplatný otisk zadání.")

  const repository: Pick<PublicGitHubRepository, "fullName"> = { fullName: input.repository }
  const plan = createDevelopmentPlan(repository, input.task)
  const provider = input.provider ?? new MockDevelopmentAgentProvider()
  const executor = input.executor ?? new DisabledIsolatedCodeExecutor()
  if (provider.mode !== "mock") throw new Error("Živý vývojový model není v této etapě povolen.")

  const now = input.now ?? (() => new Date())
  const events: DevelopmentStudioEvent[] = []
  const addEvent = (
    agentId: DevelopmentAgentId | "system",
    event: DevelopmentStudioEvent["event"],
    detailCode: DevelopmentStudioEvent["detailCode"],
  ) => events.push({
    id: `${input.id}:${events.length}`,
    runId: input.id,
    agentId,
    event,
    detailCode,
    occurredAt: now().toISOString(),
  })

  addEvent("system", "run_started", "mock_only")
  for (const [index, agent] of DEVELOPMENT_AGENTS.entries()) {
    addEvent(agent.id, "agent_started", "mock_only")
    await provider.runAgent({
      runId: input.id,
      repository: input.repository,
      task: plan.task,
      agentId: agent.id,
      deliverable: plan.steps[index]!.deliverable,
    })
    addEvent(agent.id, "agent_mocked", "mock_only")
  }
  const execution = await executor.execute({
    runId: input.id,
    repository: input.repository,
    taskHash: input.taskHash,
    approvalState: "not_authorized",
  })
  if (execution.executed) throw new Error("Executor nesmí provést kód v mock režimu.")
  addEvent("system", "executor_blocked", execution.reason)
  addEvent("system", "run_blocked", execution.reason)

  return {
    id: input.id,
    repository: input.repository,
    taskHash: input.taskHash,
    mode: "mock_only",
    status: "blocked",
    plan,
    events,
  }
}

export function createDevelopmentPlan(repository: Pick<PublicGitHubRepository, "fullName">, task: string): DevelopmentPlan {
  const normalizedTask = task.trim()
  if (normalizedTask.length < 8 || normalizedTask.length > 2000) {
    throw new Error("Zadání musí mít 8 až 2000 znaků.")
  }

  const deliverables: Record<DevelopmentAgentId, string> = {
    architect: "Vymezit změny a kritéria přijetí bez rozšíření zadání.",
    frontend: "Navrhnout UI změny pro toto zadání; pokud nejsou potřeba, uvést proč.",
    backend: "Navrhnout serverové změny a validace; pokud nejsou potřeba, uvést proč.",
    ai: "Oddělit role modelů, tool calling a budgetované kroky.",
    security: "Prověřit oprávnění, hranice důvěry a citlivá data.",
    qa: "Doplnit cílené regresní testy a ověřit jejich výstup.",
    devops: "Ověřit CI, build a chráněné Preview; neměnit produkci.",
    reviewer: "Zkontrolovat změny, výsledky testů a zbývající rizika.",
  }

  return {
    repository: repository.fullName,
    task: normalizedTask,
    steps: DEVELOPMENT_AGENTS.map((agent) => ({
      agentId: agent.id,
      title: agent.name,
      deliverable: deliverables[agent.id],
    })),
  }
}
