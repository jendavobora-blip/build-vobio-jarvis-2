"use client"

import { SlideOver } from "./slide-over"
import { AGENTS } from "@/lib/jarvis/agents"
import { formatUsd } from "@/lib/jarvis/pricing"
import type { RunState } from "@/lib/jarvis/run-state"
import type { AgentId } from "@/lib/jarvis/types"

const STATUS: Record<string, string> = {
  idle: "Nečinný",
  queued: "Ve frontě",
  thinking: "Pracuje",
  done: "Hotovo",
  error: "Chyba",
  skipped: "Přeskočen",
}

export function AgentInspector({
  agentId,
  run,
  onClose,
}: {
  agentId: AgentId | null
  run: RunState
  onClose: () => void
}) {
  const agent = agentId ? AGENTS[agentId] : null
  const rt = agentId ? run.agents[agentId] : null

  return (
    <SlideOver open={Boolean(agentId)} onClose={onClose} title={agent?.name ?? ""} description={agent?.role}>
      {agent && rt && (
        <div className="space-y-5">
          {run.source === "demo" && (
            <p className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
              DEMO REŽIM – tento obsah je ukázkový a nevznikl skutečnou prací agenta.
            </p>
          )}
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Meta label="Stav" value={STATUS[rt.status]} color={agent.color} />
            <Meta label="Pokusy" value={rt.attempts ? String(rt.attempts) : "–"} />
            <Meta label="Doba" value={rt.durationMs ? `${(rt.durationMs / 1000).toFixed(1)} s` : "–"} />
            <Meta
              label="Tokeny / cena"
              value={rt.usage ? `${rt.usage.promptTokens + rt.usage.completionTokens} · ${formatUsd(rt.usage.costUsd)}` : "–"}
            />
          </dl>
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Úkol</h3>
            <p className="mt-1 text-sm text-foreground">{rt.task}</p>
            <p className="mt-1 text-xs text-muted-foreground">Aktivita: {rt.activity}</p>
          </section>
          {rt.error && (
            <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {rt.error}
            </p>
          )}
          {rt.output ? (
            <section className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Shrnutí</h3>
                <p className="mt-1 text-[15px] leading-relaxed text-foreground">{rt.output.summary}</p>
              </div>
              {rt.output.points.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Body</h3>
                  <ul className="mt-2 ml-5 list-disc space-y-1.5 text-sm text-foreground/90 marker:text-primary">
                    {rt.output.points.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
              {rt.output.data.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Data</h3>
                  <dl className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
                    {rt.output.data.map((d, i) => (
                      <div key={i} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                        <dt className="text-muted-foreground">{d.label}</dt>
                        <dd className="text-right font-mono" style={{ color: agent.color }}>
                          {d.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                Důvěra: <span className="text-foreground">{rt.output.confidence}</span>
              </p>
              {rt.output.warnings.length > 0 && (
                <ul className="space-y-1 rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
                  {rt.output.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            !rt.error && <p className="text-sm text-muted-foreground">Agent zatím nevrátil žádný výstup.</p>
          )}
        </div>
      )}
    </SlideOver>
  )
}

function Meta({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl bg-secondary/60 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium text-foreground" style={color ? { color } : undefined}>
        {value}
      </dd>
    </div>
  )
}
