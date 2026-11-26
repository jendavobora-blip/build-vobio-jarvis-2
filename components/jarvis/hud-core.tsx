"use client"

import { useState } from "react"
import { SpatialVisualization } from "./spatial-visualization"
import { cn } from "@/lib/utils"

interface HudCoreProps {
  active: boolean
  label: string
  sublabel: string
  className?: string
}

export function HudCore({ active, label, sublabel, className }: HudCoreProps) {
  const [rendering3d, setRendering3d] = useState(false)
  return (
    <div className={cn("hud-core-3d relative mx-auto aspect-square w-full max-w-[280px]", active && "is-active", className)}>
      <div
        aria-hidden="true"
        className="core-pulse absolute inset-[18%] rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.35)_0%,rgba(34,211,238,0.08)_45%,transparent_70%)] blur-xl"
      />
      <svg viewBox="0 0 200 200" className={cn("absolute inset-0 size-full", rendering3d && "invisible")} aria-hidden="true">
        <defs>
          <radialGradient id="core-fill" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#cffafe" />
            <stop offset="40%" stopColor="#22d3ee" />
            <stop offset="100%" stopColor="#0e7490" stopOpacity="0.2" />
          </radialGradient>
        </defs>
        <g className="hud-spin-slow" style={{ transformOrigin: "100px 100px" }}>
          <circle cx="100" cy="100" r="94" fill="none" stroke="#22d3ee" strokeOpacity="0.18" strokeWidth="0.6" />
          {Array.from({ length: 72 }).map((_, i) => (
            <line
              key={i}
              x1="100"
              y1="8"
              x2="100"
              y2={i % 6 === 0 ? 15 : 11}
              stroke="#22d3ee"
              strokeOpacity={i % 6 === 0 ? 0.6 : 0.25}
              strokeWidth="0.6"
              transform={`rotate(${i * 5} 100 100)`}
            />
          ))}
        </g>
        <g className="hud-spin-mid" style={{ transformOrigin: "100px 100px" }}>
          <circle
            cx="100"
            cy="100"
            r="74"
            fill="none"
            stroke="#22d3ee"
            strokeOpacity="0.5"
            strokeWidth="1.2"
            strokeDasharray="60 22 8 22"
          />
          <circle cx="100" cy="100" r="66" fill="none" stroke="#22d3ee" strokeOpacity="0.15" strokeWidth="0.6" />
        </g>
        <g className="hud-spin-fast" style={{ transformOrigin: "100px 100px" }}>
          <circle
            cx="100"
            cy="100"
            r="54"
            fill="none"
            stroke="#67e8f9"
            strokeOpacity="0.85"
            strokeWidth="2"
            strokeDasharray="18 10"
          />
        </g>
        <circle cx="100" cy="100" r="40" fill="none" stroke="#22d3ee" strokeOpacity="0.35" strokeWidth="0.8" />
        <circle className="core-pulse" style={{ transformOrigin: "100px 100px" }} cx="100" cy="100" r="26" fill="url(#core-fill)" />
      </svg>
      <SpatialVisualization kind="core" onDisplayChange={setRendering3d} />
      <div className="absolute inset-x-0 bottom-[6%] flex flex-col items-center text-center" aria-live="polite">
        <span className="font-mono text-[11px] uppercase tracking-[0.3em] text-primary">{label}</span>
        <span className="mt-1 max-w-[85%] truncate text-xs text-muted-foreground">{sublabel}</span>
      </div>
    </div>
  )
}
