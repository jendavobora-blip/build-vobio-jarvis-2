"use client"

import { useEffect, useRef, useState } from "react"
import {
  DEVELOPMENT_AGENTS,
  createDevelopmentPlan,
  type DevelopmentPlan,
  type DevelopmentStudioEvent,
} from "@/lib/jarvis/development-studio"
import type { PublicGitHubRepository } from "@/lib/github/public-repository"

export function DevelopmentStudioScreen() {
  const [repositoryPath, setRepositoryPath] = useState("")
  const [task, setTask] = useState("")
  const [repository, setRepository] = useState<PublicGitHubRepository | null>(null)
  const [plan, setPlan] = useState<DevelopmentPlan | null>(null)
  const [mockEvents, setMockEvents] = useState<DevelopmentStudioEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [mockBusy, setMockBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadAbortRef = useRef<AbortController | null>(null)
  const loadRequestRef = useRef(0)
  const mockIdempotencyRef = useRef<string | null>(null)
  useEffect(() => () => {
    loadRequestRef.current += 1
    loadAbortRef.current?.abort()
  }, [])

  const loadRepository = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const [owner, name, extra] = repositoryPath.trim().split("/")
    if (!owner || !name || extra) {
      setError("Zadejte veřejný repozitář ve tvaru vlastník/název.")
      return
    }

    const requestId = ++loadRequestRef.current
    loadAbortRef.current?.abort()
    const controller = new AbortController()
    loadAbortRef.current = controller
    setRepository(null)
    setPlan(null)
    setMockEvents([])
    mockIdempotencyRef.current = null
    setBusy(true)
    setError(null)
    setPlan(null)
    try {
      const params = new URLSearchParams({ owner, repo: name })
      const response = await fetch(`/api/github/repository?${params}`, { cache: "no-store", signal: controller.signal })
      if (requestId !== loadRequestRef.current) return
      const body = (await response.json()) as { repository?: PublicGitHubRepository; error?: string }
      if (requestId !== loadRequestRef.current) return
      if (!response.ok || !body.repository) throw new Error(body.error ?? "Repozitář nelze načíst.")
      setRepository(body.repository)
    } catch (reason) {
      if (requestId !== loadRequestRef.current || controller.signal.aborted) return
      setRepository(null)
      setError(reason instanceof Error ? reason.message : "Repozitář nelze načíst.")
    } finally {
      if (requestId === loadRequestRef.current) setBusy(false)
    }
  }

  const preparePlan = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    if (!repository) {
      setError("Nejprve načtěte veřejný repozitář.")
      return
    }
    try {
      setPlan(createDevelopmentPlan(repository, task))
      setMockEvents([])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Plán nelze připravit.")
    }
  }

  const startMockRun = async () => {
    if (!repository || !plan) return
    setError(null)
    setMockEvents([])
    setMockBusy(true)
    const idempotencyKey = mockIdempotencyRef.current ?? crypto.randomUUID()
    mockIdempotencyRef.current = idempotencyKey
    try {
      const response = await fetch("/api/development-studio/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey, repository: repository.fullName, task }),
      })
      const body = await response.json() as { events?: DevelopmentStudioEvent[]; error?: string }
      if (!response.ok || !body.events) throw new Error(body.error ?? "Mock průchod nelze spustit.")
      setMockEvents(body.events)
      mockIdempotencyRef.current = null
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Mock průchod nelze spustit.")
    } finally {
      setMockBusy(false)
    }
  }

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-primary">Development Studio</p>
        <h2 className="text-xl font-semibold tracking-tight">Osm vývojových specializací</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Načítá pouze veřejná metadata GitHub repozitáře. Server může uložit audit bezpečného mock průchodu;
          skutečné modely, executor, změny repozitáře ani Pull Requesty zatím nejsou aktivní.
        </p>
      </header>

      <div className="glass space-y-3 rounded-2xl p-4">
        <form onSubmit={loadRepository} className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="development-repository">Veřejný GitHub repozitář</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="development-repository"
              required
              maxLength={140}
              disabled={mockBusy}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={repositoryPath}
              onChange={(event) => {
                setRepositoryPath(event.target.value)
                loadRequestRef.current += 1
                loadAbortRef.current?.abort()
                setBusy(false)
                setRepository(null)
                setPlan(null)
                setMockEvents([])
                mockIdempotencyRef.current = null
                setError(null)
              }}
              placeholder="vlastník/název"
              className="min-h-12 min-w-0 flex-1 rounded-xl border border-input bg-background px-3 text-base outline-none focus:border-primary"
            />
            <button type="submit" disabled={busy || mockBusy} className="min-h-12 rounded-xl bg-primary px-4 font-medium text-primary-foreground disabled:opacity-50">
              {busy ? "Načítám…" : "Načíst"}
            </button>
          </div>
        </form>

        {repository && (
          <article className="rounded-xl border border-primary/20 bg-primary/5 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="min-w-0 break-all font-semibold">{repository.fullName}</h3>
                <p className="[overflow-wrap:anywhere] mt-1 text-sm text-muted-foreground">{repository.description || "Repozitář nemá popis."}</p>
              </div>
              <a href={repository.url} target="_blank" rel="noopener noreferrer" className="min-h-10 shrink-0 rounded-lg border border-border px-3 py-2 text-sm text-primary">
                Otevřít na GitHubu
              </a>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Výchozí větev <code className="[overflow-wrap:anywhere]">{repository.defaultBranch}</code> · {repository.stars.toLocaleString("cs-CZ")} hvězdiček ·{" "}
              {repository.openIssues.toLocaleString("cs-CZ")} otevřených issues
            </p>
            <h4 className="mt-4 text-sm font-medium">Poslední commity</h4>
            {repository.commits.length ? (
              <ol className="mt-2 space-y-2">
                {repository.commits.map((commit) => (
                  <li key={commit.sha} className="border-t border-border/70 pt-2">
                    <a href={commit.url} target="_blank" rel="noopener noreferrer" className="[overflow-wrap:anywhere] text-sm font-medium hover:text-primary">
                      {commit.message}
                    </a>
                    <p className="mt-1 text-xs text-muted-foreground">{commit.author} · {commit.sha.slice(0, 7)}</p>
                  </li>
                ))}
              </ol>
            ) : <p className="mt-2 text-sm text-muted-foreground">Repozitář zatím nemá žádné commity.</p>}
          </article>
        )}
      </div>

      <form onSubmit={preparePlan} className="glass space-y-3 rounded-2xl p-4">
        <label className="block text-sm font-medium" htmlFor="development-task">Vývojové zadání</label>
        <textarea
          id="development-task"
          required
          minLength={8}
          maxLength={2000}
          disabled={mockBusy}
          value={task}
          onChange={(event) => {
            setTask(event.target.value)
            setPlan(null)
            setMockEvents([])
            mockIdempotencyRef.current = null
          }}
          placeholder="Popište změnu a očekávaný výsledek…"
          className="min-h-24 w-full rounded-xl border border-input bg-background p-3 text-base outline-none focus:border-primary"
        />
        <button type="submit" disabled={!repository || mockBusy} className="min-h-11 rounded-xl bg-secondary px-4 text-sm font-medium disabled:opacity-50">
          Připravit kontrolní plán
        </button>
      </form>

      {error && <p role="alert" className="rounded-xl border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        {DEVELOPMENT_AGENTS.map((agent) => {
          const step = plan?.steps.find((item) => item.agentId === agent.id)
          return (
            <article key={agent.id} className="glass rounded-2xl p-4">
              <h3 className="font-semibold">{agent.name}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{agent.focus}</p>
              {step && <p className="mt-3 border-t border-border/70 pt-3 text-sm">{step.deliverable}</p>}
            </article>
          )
        })}
      </div>
      {plan && (
        <div className="space-y-3 rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground">
          <p role="status">
            Plán pro <strong>{plan.repository}</strong> zatím nevykonává změny. Bezpečný mock pouze ověří serverové řízení osmi rolí;
            nevolá model, nečte zdrojový kód, nespouští příkazy a zapisuje pouze stavové události.
          </p>
          <button
            type="button"
            disabled={mockBusy}
            onClick={startMockRun}
            className="min-h-11 rounded-xl border border-warning/50 px-4 font-medium disabled:opacity-50"
          >
            {mockBusy ? "Ověřuji mock…" : "Ověřit bezpečný mock průchod"}
          </button>
          {mockEvents.length > 0 && (
            <ol aria-label="Události bezpečného mock průchodu" className="space-y-1 border-t border-border/70 pt-3">
              {mockEvents.map((item) => {
                const agentName = DEVELOPMENT_AGENTS.find((agent) => agent.id === item.agentId)?.name ?? "Executor"
                return (
                  <li key={item.id} className="flex flex-wrap justify-between gap-2">
                    <span>{agentName}: {item.event.replaceAll("_", " ")}</span>
                    <span className="font-mono text-xs">{item.detailCode}</span>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      )}
    </section>
  )
}
