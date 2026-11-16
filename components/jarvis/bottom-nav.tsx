"use client"

import { Brain, LayoutGrid, Mic, Radar, Settings2 } from "lucide-react"
import { cn } from "@/lib/utils"

export type JarvisView = "core" | "canvas"

interface BottomNavProps {
  view: JarvisView
  onView: (v: JarvisView) => void
  onMemory: () => void
  onSettings: () => void
  onMic: () => void
  listening: boolean
  running: boolean
}

export function BottomNav({ view, onView, onMemory, onSettings, onMic, listening, running }: BottomNavProps) {
  return (
    <nav aria-label="Hlavní navigace" className="fixed inset-x-0 bottom-0 z-40 pb-safe">
      <div className="glass mx-auto mb-2 flex max-w-md items-center justify-between rounded-3xl px-2 py-1.5 sm:mb-4">
        <NavButton label="Velín" active={view === "core"} onClick={() => onView("core")}>
          <Radar className="size-5" aria-hidden="true" />
        </NavButton>
        <NavButton label="Plátno" active={view === "canvas"} onClick={() => onView("canvas")} badge={running}>
          <LayoutGrid className="size-5" aria-hidden="true" />
        </NavButton>
        <button
          type="button"
          onClick={onMic}
          aria-label={listening ? "Zastavit poslech" : "Mluvit s JARVISem"}
          aria-pressed={listening}
          className={cn(
            "-mt-8 flex size-16 shrink-0 items-center justify-center rounded-full border-4 border-background transition-transform active:scale-95",
            listening
              ? "bg-destructive text-white shadow-[0_0_30px_-4px_#f43f5e]"
              : "bg-primary text-primary-foreground shadow-[0_0_32px_-4px_#22d3ee]",
          )}
        >
          <Mic className="size-7" aria-hidden="true" />
        </button>
        <NavButton label="Paměť" onClick={onMemory}>
          <Brain className="size-5" aria-hidden="true" />
        </NavButton>
        <NavButton label="Nastavení" onClick={onSettings}>
          <Settings2 className="size-5" aria-hidden="true" />
        </NavButton>
      </div>
    </nav>
  )
}

function NavButton({
  label,
  active,
  onClick,
  badge,
  children,
}: {
  label: string
  active?: boolean
  onClick: () => void
  badge?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex min-h-12 min-w-14 flex-col items-center justify-center gap-0.5 rounded-2xl px-2 text-[11px] font-medium transition-colors",
        active ? "text-primary" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
      <span>{label}</span>
      {badge && (
        <span className="absolute right-3 top-1.5 size-2 rounded-full bg-primary shadow-[0_0_8px_#22d3ee]" aria-label="Probíhá běh" />
      )}
    </button>
  )
}
