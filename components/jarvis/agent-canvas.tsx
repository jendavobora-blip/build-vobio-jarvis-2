"use client"

import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { AlertTriangle, CheckCircle2, Loader2, MinusCircle } from "lucide-react"
import { AGENTS, AGENT_ORDER } from "@/lib/jarvis/agents"
import type { AgentRuntime, RunState } from "@/lib/jarvis/run-state"
import type { AgentId } from "@/lib/jarvis/types"
import { cn } from "@/lib/utils"

const CARD_W = 46
const CARD_H = 19

const STATUS_LABEL: Record<AgentRuntime["status"], string> = {
  idle: "Nečinný",
  queued: "Ve frontě",
  thinking: "Pracuje",
  done: "Hotovo",
  error: "Chyba",
  skipped: "Přeskočen",
}

const HOME: Record<AgentId, { x: number; y: number }> = {
  orchestrator: { x: 46, y: 90 },
  researcher: { x: 6, y: 90 },
  memory: { x: 20, y: 94 },
  planner: { x: 33, y: 89 },
  analyst: { x: 60, y: 94 },
  creator: { x: 72, y: 89 },
  auditor: { x: 84, y: 94 },
}

function cursorTarget(id: AgentId, rt: AgentRuntime): { x: number; y: number } {
  const s = AGENTS[id].slot
  switch (rt.status) {
    case "idle":
      return HOME[id]
    case "queued":
      return { x: s.x + 1, y: s.y + 1 }
    case "thinking":
      return { x: s.x + CARD_W - 6, y: s.y + CARD_H - 5 }
    case "done":
    case "error":
      return { x: s.x + CARD_W - 3, y: s.y + 2 }
    case "skipped":
      return HOME[id]
  }
}

function center(id: AgentId) {
  const s = AGENTS[id].slot
  return { x: s.x + CARD_W / 2, y: s.y + CARD_H / 2 }
}

interface AgentCanvasProps {
  run: RunState
  onInspect: (id: AgentId) => void
}

export function AgentCanvas({ run, onInspect }: AgentCanvasProps) {
  const reduce = useReducedMotion()
  const isDemo = run.source === "demo"

  return (
    <div className="relative">
      {isDemo && (
        <div className="absolute left-1/2 top-2 z-30 -translate-x-1/2 rounded-full border border-warning/50 bg-warning/15 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-widest text-warning">
          DEMO REŽIM – simulace
        </div>
      )}
      <div
        className="hud-grid glass relative h-[640px] w-full overflow-hidden rounded-3xl"
        role="region"
        aria-label="Agentické plátno – stav agentů"
      >
        <svg
          className="pointer-events-none absolute inset-0 size-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <AnimatePresence>
            {run.links.map((l) => {
              const a = center(l.from)
              const b = center(l.to)
              return (
                <motion.line
                  key={`${l.from}-${l.to}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={AGENTS[l.from].color}
                  strokeOpacity={0.55}
                  strokeWidth={1.2}
                  strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke"
                  initial={{ pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduce ? 0 : 0.6, ease: "easeOut" }}
                />
              )
            })}
          </AnimatePresence>
        </svg>

        {AGENT_ORDER.map((id) => (
          <AgentSlot key={id} id={id} rt={run.agents[id]} reduce={Boolean(reduce)} onInspect={onInspect} />
        ))}

        {AGENT_ORDER.map((id) => (
          <AgentCursor key={id} id={id} rt={run.agents[id]} reduce={Boolean(reduce)} />
        ))}
      </div>
    </div>
  )
}

function AgentSlot({
  id,
  rt,
  reduce,
  onInspect,
}: {
  id: AgentId
  rt: AgentRuntime
  reduce: boolean
  onInspect: (id: AgentId) => void
}) {
  const agent = AGENTS[id]
  const visible = rt.status !== "idle"
  const materialized = rt.status === "done" || rt.status === "error" || Boolean(rt.output)
  const style = {
    left: `${agent.slot.x}%`,
    top: `${agent.slot.y}%`,
    width: `${CARD_W}%`,
    height: `${CARD_H}%`,
  }

  return (
    <div className="absolute" style={style}>
      <AnimatePresence>
        {visible && !materialized && (
          <motion.svg
            key="wire"
            className="pointer-events-none absolute inset-0 size-full overflow-visible"
            initial={{ opacity: 0 }}
            animate={{ opacity: rt.status === "skipped" ? 0.25 : 1 }}
            exit={{ opacity: 0 }}
            aria-hidden="true"
          >
            <motion.rect
              x="0"
              y="0"
              width="100%"
              height="100%"
              rx="14"
              fill="none"
              stroke={agent.color}
              strokeWidth="1.5"
              strokeDasharray={rt.status === "thinking" ? "0" : "6 6"}
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: reduce ? 0 : 0.9, ease: "easeInOut" }}
              style={{ filter: `drop-shadow(0 0 6px ${agent.color})` }}
            />
          </motion.svg>
        )}
      </AnimatePresence>

      <motion.button
        type="button"
        onClick={() => onInspect(id)}
        aria-label={`${agent.name}: ${STATUS_LABEL[rt.status]}. Otevřít detail.`}
        className={cn(
          "relative flex size-full flex-col overflow-hidden rounded-2xl p-2.5 text-left transition-colors",
          materialized ? "glass" : "bg-transparent",
          rt.status === "error" && "border-destructive/60",
          rt.status === "skipped" && "opacity-40",
        )}
        style={materialized ? { boxShadow: `inset 0 0 0 1px ${agent.color}40, 0 0 24px -8px ${agent.color}` } : undefined}
        initial={false}
        animate={{ scale: materialized && !reduce ? [0.96, 1] : 1 }}
        transition={{ duration: 0.35 }}
      >
        <div className="flex items-center gap-1.5">
          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: agent.color }} aria-hidden="true" />
          <span className="truncate text-[12px] font-semibold text-foreground">{agent.name}</span>
          <StatusIcon status={rt.status} />
        </div>
        {rt.status === "idle" ? (
          <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground/70">{agent.role}</p>
        ) : rt.output ? (
          <>
            <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-foreground/85">{rt.output.summary}</p>
            {rt.output.data[0] && (
              <p className="mt-auto truncate font-mono text-[10px] text-muted-foreground">
                {rt.output.data[0].label}: <span style={{ color: agent.color }}>{rt.output.data[0].value}</span>
              </p>
            )}
          </>
        ) : (
          <>
            <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-foreground/75">{rt.task}</p>
            {rt.error && <p className="mt-auto line-clamp-2 text-[10px] text-destructive">{rt.error}</p>}
          </>
        )}
      </motion.button>
    </div>
  )
}

function StatusIcon({ status }: { status: AgentRuntime["status"] }) {
  const cls = "ml-auto size-3.5 shrink-0"
  if (status === "thinking") return <Loader2 className={cn(cls, "animate-spin text-primary motion-reduce:animate-none")} aria-hidden="true" />
  if (status === "done") return <CheckCircle2 className={cn(cls, "text-success")} aria-hidden="true" />
  if (status === "error") return <AlertTriangle className={cn(cls, "text-destructive")} aria-hidden="true" />
  if (status === "skipped") return <MinusCircle className={cn(cls, "text-muted-foreground")} aria-hidden="true" />
  return null
}

function AgentCursor({ id, rt, reduce }: { id: AgentId; rt: AgentRuntime; reduce: boolean }) {
  const agent = AGENTS[id]
  const target = cursorTarget(id, rt)
  const flipLabel = target.x > 62
  const compact = rt.status === "idle" || rt.status === "skipped"

  return (
    <motion.div
      className="pointer-events-none absolute z-20"
      initial={false}
      animate={{ left: `${target.x}%`, top: `${target.y}%`, opacity: rt.status === "skipped" ? 0.35 : 1 }}
      transition={reduce ? { duration: 0 } : { type: "spring", damping: 22, stiffness: 90, mass: 0.9 }}
      aria-hidden="true"
    >
      <svg width="16" height="18" viewBox="0 0 16 18" style={{ filter: `drop-shadow(0 0 4px ${agent.color})` }}>
        <path d="M1 1 L15 8 L8.5 9.5 L5.5 16.5 Z" fill={agent.color} stroke="#0a0a0c" strokeWidth="1" />
      </svg>
      <div
        className={cn(
          "absolute top-4 max-w-[150px] rounded-md px-1.5 py-0.5 text-[10px] font-medium leading-tight text-[#0a0a0c] shadow-lg",
          flipLabel ? "right-2" : "left-3",
        )}
        style={{ backgroundColor: agent.color }}
      >
        <span className="block truncate font-semibold">{compact ? agent.name.split(" ")[0] : agent.name}</span>
        {!compact && <span className="block truncate opacity-80">{rt.activity}</span>}
      </div>
    </motion.div>
  )
}
