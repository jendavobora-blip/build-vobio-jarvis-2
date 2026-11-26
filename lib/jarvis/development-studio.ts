import type { PublicGitHubRepository } from "@/lib/github/public-repository"

export const DEVELOPMENT_AGENTS = [
  { id: "architect", name: "Architekt", focus: "Rozsah, návrh a akceptační kritéria" },
  { id: "frontend", name: "Frontend vývojář", focus: "Responzivní rozhraní a přístupnost" },
  { id: "backend", name: "Backend vývojář", focus: "API, datové toky a validace" },
  { id: "data", name: "Datový specialista", focus: "Schéma, migrace a integrita dat" },
  { id: "testing", name: "Testovací inženýr", focus: "Regresní, integrační a E2E testy" },
  { id: "security", name: "Bezpečnostní auditor", focus: "Oprávnění, izolace a úniky dat" },
  { id: "devops", name: "DevOps inženýr", focus: "Build, CI a bezpečné Preview" },
  { id: "documentation", name: "Dokumentační koordinátor", focus: "Dokumentace, kontrolní seznam a PR" },
] as const

export interface DevelopmentPlan {
  repository: string
  task: string
  steps: { agentId: (typeof DEVELOPMENT_AGENTS)[number]["id"]; title: string; deliverable: string }[]
}

export function createDevelopmentPlan(repository: PublicGitHubRepository, task: string): DevelopmentPlan {
  const normalizedTask = task.trim()
  if (normalizedTask.length < 8 || normalizedTask.length > 2000) {
    throw new Error("Zadání musí mít 8 až 2000 znaků.")
  }

  const deliverables: Record<(typeof DEVELOPMENT_AGENTS)[number]["id"], string> = {
    architect: "Vymezit změny a kritéria přijetí bez rozšíření zadání.",
    frontend: "Navrhnout UI změny pro toto zadání; pokud nejsou potřeba, uvést proč.",
    backend: "Navrhnout serverové změny a validace; pokud nejsou potřeba, uvést proč.",
    data: "Prověřit dopad na datové schéma a navrhnout nedestruktivní migraci, jen pokud je nutná.",
    testing: "Doplnit cílené regresní testy a ověřit jejich výstup.",
    security: "Prověřit oprávnění, hranice důvěry a citlivá data.",
    devops: "Ověřit CI, build a chráněné Preview; neměnit produkci.",
    documentation: "Připravit přehled commitu, testů a omezení pro Pull Request.",
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
