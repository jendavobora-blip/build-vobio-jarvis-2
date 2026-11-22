"use client"

import useSWR from "swr"
import { useLocalState } from "@/lib/jarvis/local-store"
import { SPECIALISTS } from "@/lib/jarvis/agents"
import type { AnalysisDepth, ModelId, SpecialistId, StatusResponse, WorkMode } from "@/lib/jarvis/types"

export interface JarvisSettings {
  liveMode: boolean
  mode: WorkMode
  depth: AnalysisDepth
  model: ModelId
  reasoning: boolean
  enabledAgents: SpecialistId[]
  maxTokens: number
  maxCostUsd: number
  speakAnswers: boolean
  demoLoop: boolean
  useSensitiveInContext: boolean
  autoHistory: boolean
}

const DEFAULT_SETTINGS: JarvisSettings = {
  liveMode: true,
  mode: "universal",
  depth: "quick",
  model: "deepseek-flash",
  reasoning: false,
  enabledAgents: [...SPECIALISTS],
  maxTokens: 40_000,
  maxCostUsd: 0.02,
  speakAnswers: false,
  demoLoop: false,
  useSensitiveInContext: false,
  autoHistory: true,
}

export interface LifetimeUsage {
  runs: number
  promptTokens: number
  completionTokens: number
  costUsd: number
}

const DEFAULT_USAGE: LifetimeUsage = { runs: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }

export function useJarvisSettings() {
  return useLocalState<JarvisSettings>("vobio-jarvis.settings.v1", DEFAULT_SETTINGS)
}

export function useLifetimeUsage() {
  return useLocalState<LifetimeUsage>("vobio-jarvis.usage.v1", DEFAULT_USAGE)
}

const fetchJson = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export function useServerStatus() {
  return useSWR<StatusResponse>("/api/status", fetchJson, { revalidateOnFocus: true })
}

/** Live execution requires a server key, configured auth, a valid session and the user toggle. */
export function canRunLive(status: StatusResponse | undefined, settings: JarvisSettings): boolean {
  return Boolean(status?.liveEnabled && status.deepseekConfigured && status.authConfigured && status.authenticated && settings.liveMode)
}
