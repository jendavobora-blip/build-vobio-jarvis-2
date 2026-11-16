"use client"

import { motion, useReducedMotion } from "motion/react"
import { AlertTriangle, Copy, ShieldAlert, Square, Volume2 } from "lucide-react"
import { useState } from "react"
import { RichText } from "./rich-text"
import { formatUsd } from "@/lib/jarvis/pricing"
import type { RunState } from "@/lib/jarvis/run-state"

interface ResultPanelProps {
  run: RunState
  speaking: boolean
  canSpeak: boolean
  onSpeak: (text: string) => void
  onStopSpeaking: () => void
}

export function ResultPanel({ run, speaking, canSpeak, onSpeak, onStopSpeaking }: ResultPanelProps) {
  const reduce = useReducedMotion()
  const [copied, setCopied] = useState(false)
  if (run.phase === "idle") return null

  const copy = async () => {
    if (!run.final) return
    try {
      await navigator.clipboard.writeText(run.final.answer)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: reduce ? 0 : 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass space-y-4 rounded-3xl p-5"
      aria-labelledby="result-heading"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="result-heading" className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
            {run.source === "demo" ? "Výsledek · DEMO" : "Výsledek"}
          </h2>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{run.prompt}</p>
        </div>
        {run.final && (
          <div className="flex shrink-0 gap-2">
            {canSpeak &&
              (speaking ? (
                <IconButton label="Zastavit předčítání" onClick={onStopSpeaking}>
                  <Square className="size-4" aria-hidden="true" />
                </IconButton>
              ) : (
                <IconButton label="Přečíst nahlas" onClick={() => onSpeak(run.final!.answer)}>
                  <Volume2 className="size-4" aria-hidden="true" />
                </IconButton>
              ))}
            <IconButton label={copied ? "Zkopírováno" : "Kopírovat odpověď"} onClick={copy}>
              <Copy className="size-4" aria-hidden="true" />
            </IconButton>
          </div>
        )}
      </div>

      {run.phase === "running" && !run.final && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
          </span>
          {run.source === "demo" ? "Probíhá ukázková simulace…" : "Agenti pracují – sledujte plátno…"}
        </div>
      )}

      {run.final && <RichText text={run.final.answer} />}

      {run.final && run.final.nextSteps.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Další kroky</h3>
          <ol className="mt-2 ml-5 list-decimal space-y-1 text-sm text-foreground/90">
            {run.final.nextSteps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}

      {run.final && run.final.needsApproval.length > 0 && (
        <div className="rounded-2xl border border-warning/40 bg-warning/10 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-warning">
            <ShieldAlert className="size-4" aria-hidden="true" /> Vyžaduje váš výslovný souhlas
          </h3>
          <ul className="mt-2 ml-5 list-disc space-y-1 text-sm text-foreground/90">
            {run.final.needsApproval.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            JARVIS tyto akce sám neprovádí. Žádné obchody, platby ani zprávy nebyly odeslány.
          </p>
        </div>
      )}

      {run.error && (
        <p role="alert" className="flex gap-2 rounded-2xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {run.error}
        </p>
      )}

      {run.notices.length > 0 && (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer py-2">Upozornění během běhu ({run.notices.length})</summary>
          <ul className="ml-5 list-disc space-y-1">
            {run.notices.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </details>
      )}

      {run.source === "live" && (
        <p className="border-t border-border pt-3 font-mono text-[11px] text-muted-foreground">
          {run.usage.promptTokens + run.usage.completionTokens} tokenů · odhad {formatUsd(run.usage.costUsd)}
          {run.budget && ` / limit ${formatUsd(run.budget.maxCostUsd)}`}
          {run.durationMs !== null && ` · ${(run.durationMs / 1000).toFixed(1)} s`}
        </p>
      )}
    </motion.section>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-11 items-center justify-center rounded-full bg-secondary text-muted-foreground transition-colors hover:text-primary active:scale-95"
    >
      {children}
    </button>
  )
}
