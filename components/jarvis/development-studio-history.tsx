"use client"

import { useEffect, useRef, useState } from "react"
import { DEVELOPMENT_AGENTS, type DevelopmentStudioEvent } from "@/lib/jarvis/development-studio"

type StudioRun = {
  id: string
  repository: string
  mode: "mock_only"
  status: "blocked" | "failed"
  created_at: string
}

export function DevelopmentStudioHistory() {
  const [runs, setRuns] = useState<StudioRun[] | null>(null)
  const [events, setEvents] = useState<DevelopmentStudioEvent[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef<AbortController | null>(null)

  useEffect(() => () => requestRef.current?.abort(), [])

  const load = async (runId?: string) => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    setError(null)
    setEvents(null)
    setSelectedId(null)
    if (!runId) setRuns(null)
    try {
      const url = runId ? `/api/development-studio/runs?${new URLSearchParams({ runId })}` : "/api/development-studio/runs"
      const response = await fetch(url, { cache: "no-store", signal: controller.signal })
      const body = await response.json() as { runs?: StudioRun[]; events?: DevelopmentStudioEvent[]; error?: string }
      if (controller.signal.aborted) return
      if (!response.ok) throw new Error(body.error ?? "Historii nelze načíst.")
      if (runId) {
        if (!Array.isArray(body.events)) throw new Error("Neplatná odpověď historie.")
        setSelectedId(runId)
        setEvents(body.events)
      } else {
        if (!Array.isArray(body.runs)) throw new Error("Neplatná odpověď historie.")
        setRuns(body.runs)
      }
    } catch (reason) {
      if (controller.signal.aborted) return
      setRuns(null)
      setError(reason instanceof Error ? reason.message : "Historii nelze načíst.")
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  return (
    <section className="glass space-y-3 rounded-2xl p-4" aria-labelledby="studio-history-title">
      <h3 id="studio-history-title" className="font-semibold">Historie mock průchodů</h3>
      <p className="text-sm text-muted-foreground">
        Historie je dostupná po přihlášení. Zadání se do ní neukládá; události neznamenají skutečné vykonání kódu.
      </p>
      <button type="button" onClick={() => void load()} disabled={loading} className="min-h-11 rounded-xl bg-secondary px-4 text-sm font-medium disabled:opacity-50">
        {loading ? "Načítám…" : "Načíst historii"}
      </button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {runs?.length === 0 && <p className="text-sm text-muted-foreground">Zatím nemáte žádné mock průchody.</p>}
      {runs && runs.length > 0 && (
        <ul className="space-y-2" aria-label="Uložené mock průchody">
          {runs.map((run) => (
            <li key={run.id} className="rounded-xl border border-border p-3">
              <p className="break-all font-medium">{run.repository}</p>
              <p className="text-xs text-muted-foreground">
                Mock · {run.status === "blocked" ? "executor zablokován" : "selhání"} · {new Date(run.created_at).toLocaleString("cs-CZ")}
              </p>
              <button type="button" onClick={() => void load(run.id)} aria-pressed={selectedId === run.id} className="mt-2 min-h-11 rounded-lg border border-border px-3 text-sm">
                Zobrazit události
              </button>
            </li>
          ))}
        </ul>
      )}
      {events && (
        <ol aria-label="Uložené události mock průchodu" className="space-y-1 border-t border-border pt-3 text-sm">
          {events.map((item) => (
            <li key={item.id} className="flex flex-wrap justify-between gap-2">
              <span>{DEVELOPMENT_AGENTS.find((agent) => agent.id === item.agentId)?.name ?? "Executor"}: {item.event.replaceAll("_", " ")}</span>
              <span className="font-mono text-xs">{item.detailCode}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
