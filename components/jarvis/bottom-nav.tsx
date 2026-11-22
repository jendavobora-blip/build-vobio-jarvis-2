"use client"

import {
  BarChart3,
  Brain,
  FolderKanban,
  GitBranch,
  Mic,
  Radar,
  Settings2,
  Timer,
  Users,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"

export type JarvisView =
  | "command"
  | "agents"
  | "orchestration"
  | "projects"
  | "automations"
  | "voice"
  | "memory"
  | "analytics"
  | "settings"

const SCREENS: { id: JarvisView; label: string; icon: LucideIcon }[] = [
  { id: "command", label: "Velín", icon: Radar },
  { id: "agents", label: "Agenti", icon: Users },
  { id: "orchestration", label: "Tok", icon: GitBranch },
  { id: "projects", label: "Projekty", icon: FolderKanban },
  { id: "automations", label: "Rutiny", icon: Timer },
  { id: "voice", label: "Hlas", icon: Mic },
  { id: "memory", label: "Paměť", icon: Brain },
  { id: "analytics", label: "Přehled", icon: BarChart3 },
  { id: "settings", label: "Nastavení", icon: Settings2 },
]

interface BottomNavProps {
  view: JarvisView
  onView: (v: JarvisView) => void
  running: boolean
}

export function BottomNav({ view, onView, running }: BottomNavProps) {
  return (
    <nav aria-label="Hlavní navigace" className="fixed inset-x-0 bottom-0 z-40 pb-safe">
      <div className="glass mx-auto mb-2 flex max-w-3xl gap-1 overflow-x-auto rounded-3xl px-2 py-1.5 sm:mb-4">
        {SCREENS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => onView(id)}
            aria-current={view === id ? "page" : undefined}
            aria-label={label}
            className={cn(
              "relative flex min-h-12 min-w-[3.7rem] shrink-0 flex-col items-center justify-center gap-0.5 rounded-2xl px-2 text-[10px] font-medium transition-colors",
              view === id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-[18px]" aria-hidden="true" />
            <span>{label}</span>
            {id === "orchestration" && running && <span className="absolute right-2 top-1 size-1.5 rounded-full bg-primary shadow-[0_0_8px_#22d3ee]" aria-label="Probíhá běh" />}
          </button>
        ))}
      </div>
    </nav>
  )
}
