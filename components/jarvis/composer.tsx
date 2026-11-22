"use client"

import { ArrowUp, Mic, MicOff, Square } from "lucide-react"
import { forwardRef } from "react"
import { MODE_LABELS } from "@/lib/jarvis/agents"
import type { WorkMode } from "@/lib/jarvis/types"
import { cn } from "@/lib/utils"

interface ComposerProps {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onStop: () => void
  running: boolean
  autoFocus?: boolean
  mode: WorkMode
  onModeChange: (m: WorkMode) => void
  listening: boolean
  onMic: () => void
  isDemo: boolean
}

export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { value, onChange, onSubmit, onStop, running, mode, onModeChange, listening, onMic, isDemo, autoFocus },
  ref,
) {
  const canSend = value.trim().length >= 2 && !running

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Pracovní režim" className="grid grid-cols-3 gap-1 rounded-2xl bg-secondary/70 p-1">
        {(Object.keys(MODE_LABELS) as WorkMode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => onModeChange(m)}
            className={cn(
              "min-h-11 rounded-xl px-2 text-sm font-medium transition-colors",
              mode === m ? "bg-primary text-primary-foreground shadow-[0_0_20px_-6px_#22d3ee]" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {MODE_LABELS[m].label}
          </button>
        ))}
      </div>
      <p className="px-1 text-xs text-muted-foreground">{MODE_LABELS[mode].hint}</p>

      <form
        className="glass flex items-end gap-2 rounded-3xl p-2 focus-within:border-primary/50"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSend) onSubmit()
        }}
      >
        <label htmlFor="jarvis-input" className="sr-only">
          Zadání pro JARVISe
        </label>
        <textarea
          ref={ref}
          autoFocus={autoFocus}
          id="jarvis-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              e.preventDefault()
              if (canSend) onSubmit()
            }
          }}
          rows={2}
          maxLength={4000}
          enterKeyHint="send"
          lang="cs"
          placeholder={isDemo ? "Napište zadání (DEMO – bez volání API)…" : "Na čem budeme pracovat?"}
          className="max-h-40 min-h-12 flex-1 resize-none bg-transparent px-3 py-2.5 text-base text-foreground outline-none placeholder:text-muted-foreground/70"
        />
        <button
          type="button"
          onClick={onMic}
          aria-label={listening ? "Zastavit diktování" : "Diktovat hlasem"}
          aria-pressed={listening}
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-full transition-colors",
            listening ? "bg-destructive text-white" : "bg-secondary text-muted-foreground hover:text-primary",
          )}
        >
          {listening ? <MicOff className="size-5" aria-hidden="true" /> : <Mic className="size-5" aria-hidden="true" />}
        </button>
        {running ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Zastavit běh"
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-destructive/90 text-white"
          >
            <Square className="size-4" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Odeslat zadání"
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-30"
          >
            <ArrowUp className="size-5" aria-hidden="true" />
          </button>
        )}
      </form>
    </div>
  )
})
