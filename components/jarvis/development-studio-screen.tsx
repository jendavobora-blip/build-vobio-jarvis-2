"use client"

import { useState } from "react"
import { DEVELOPMENT_AGENTS, createDevelopmentPlan, type DevelopmentPlan } from "@/lib/jarvis/development-studio"
import type { PublicGitHubRepository } from "@/lib/github/public-repository"

export function DevelopmentStudioScreen() {
  const [repositoryPath, setRepositoryPath] = useState("")
  const [task, setTask] = useState("")
  const [repository, setRepository] = useState<PublicGitHubRepository | null>(null)
  const [plan, setPlan] = useState<DevelopmentPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadRepository = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const [owner, name, extra] = repositoryPath.trim().split("/")
    if (!owner || !name || extra) {
      setError("Zadejte veřejný repozitář ve tvaru vlastník/název.")
      return
    }

    setBusy(true)
    setError(null)
    setPlan(null)
    try {
      const params = new URLSearchParams({ owner, repo: name })
      const response = await fetch(`/api/github/repository?${params}`, { cache: "no-store" })
      const body = (await response.json()) as { repository?: PublicGitHubRepository; error?: string }
      if (!response.ok || !body.repository) throw new Error(body.error ?? "Repozitář nelze načíst.")
      setRepository(body.repository)
    } catch (reason) {
      setRepository(null)
      setError(reason instanceof Error ? reason.message : "Repozitář nelze načíst.")
    } finally {
      setBusy(false)
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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Plán nelze připravit.")
    }
  }

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-primary">Development Studio</p>
        <h2 className="text-xl font-semibold tracking-tight">Osm vývojových specializací</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Načítá pouze veřejná metadata GitHub repozitáře. Tato etapa připraví kontrolní plán; AI agenti zatím nespouštějí
          model, neupravují repozitář ani nevytvářejí Pull Request.
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
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={repositoryPath}
              onChange={(event) => setRepositoryPath(event.target.value)}
              placeholder="vlastník/název"
              className="min-h-12 min-w-0 flex-1 rounded-xl border border-input bg-background px-3 text-base outline-none focus:border-primary"
            />
            <button type="submit" disabled={busy} className="min-h-12 rounded-xl bg-primary px-4 font-medium text-primary-foreground disabled:opacity-50">
              {busy ? "Načítám…" : "Načíst"}
            </button>
          </div>
        </form>

        {repository && (
          <article className="rounded-xl border border-primary/20 bg-primary/5 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="font-semibold">{repository.fullName}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{repository.description || "Repozitář nemá popis."}</p>
              </div>
              <a href={repository.url} target="_blank" rel="noopener noreferrer" className="min-h-10 rounded-lg border border-border px-3 py-2 text-sm text-primary">
                Otevřít na GitHubu
              </a>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Výchozí větev <code>{repository.defaultBranch}</code> · {repository.stars.toLocaleString("cs-CZ")} hvězdiček ·{" "}
              {repository.openIssues.toLocaleString("cs-CZ")} otevřených issues
            </p>
            <h4 className="mt-4 text-sm font-medium">Poslední commity</h4>
            {repository.commits.length ? (
              <ol className="mt-2 space-y-2">
                {repository.commits.map((commit) => (
                  <li key={commit.sha} className="border-t border-border/70 pt-2">
                    <a href={commit.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium hover:text-primary">
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
          value={task}
          onChange={(event) => setTask(event.target.value)}
          placeholder="Popište změnu a očekávaný výsledek…"
          className="min-h-24 w-full rounded-xl border border-input bg-background p-3 text-base outline-none focus:border-primary"
        />
        <button type="submit" disabled={!repository} className="min-h-11 rounded-xl bg-secondary px-4 text-sm font-medium disabled:opacity-50">
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
        <p role="status" className="rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground">
          Plán pro <strong>{plan.repository}</strong> je pouze lokální příprava. Je potřeba ještě bezpečný izolovaný runner a schválené AI rozpočty; žádná externí změna nebyla provedena.
        </p>
      )}
    </section>
  )
}
