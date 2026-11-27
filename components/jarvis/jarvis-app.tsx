"use client"

import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { AgentCanvas } from "./agent-canvas"
import { AgentInspector } from "./agent-inspector"
import { BottomNav, type JarvisView } from "./bottom-nav"
import { Composer } from "./composer"
import { HudCore } from "./hud-core"
import { MemoryDrawer } from "./memory-drawer"
import { ResultPanel } from "./result-panel"
import { SettingsDrawer } from "./settings-drawer"
import { SpatialVisualization } from "./spatial-visualization"
import { DevelopmentStudioScreen } from "./development-studio-screen"
import {
  AnalyticsScreen,
  ApprovalsScreen,
  AutomationsScreen,
  MemoryScreen,
  ProjectsScreen,
  SettingsScreen,
  VoiceScreen,
} from "./operational-screens"
import { canRunLive, useJarvisSettings, useLifetimeUsage, useServerStatus } from "@/hooks/use-jarvis-settings"
import { useJarvisRun } from "@/hooks/use-jarvis-run"
import { useMemories } from "@/hooks/use-memories"
import { useCzechVoice } from "@/hooks/use-czech-voice"
import { AGENTS } from "@/lib/jarvis/agents"
import { formatUsd } from "@/lib/jarvis/pricing"
import type { AgentId, StatusResponse } from "@/lib/jarvis/types"
import type { JarvisProject } from "@/lib/jarvis/projects"
import { cn } from "@/lib/utils"

export function JarvisApp() {
  const reduce = useReducedMotion()
  const [settings, setSettings] = useJarvisSettings()
  const status = useServerStatus()

  const [view, setView] = useState<JarvisView>("command")
  const [input, setInput] = useState("")
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [authRevision, setAuthRevision] = useState(0)
  const [authPending, setAuthPending] = useState(false)
  const [authError, setAuthError] = useState(false)
  const [inspect, setInspect] = useState<AgentId | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const authRequestRef = useRef(0)
  const authAbortRef = useRef<AbortController | null>(null)
  const previousScopeRef = useRef<string | null>(null)
  const resolvedScope = status.data
    ? status.data.authenticated
      ? status.data.accountScope ?? null
      : "anonymous"
    : null
  const scopeChanged = Boolean(
    resolvedScope && previousScopeRef.current && previousScopeRef.current !== resolvedScope,
  )
  const sessionReady = Boolean(!authPending && !status.error && resolvedScope && !scopeChanged)
  const accountScope = sessionReady ? resolvedScope : previousScopeRef.current
  const [lifetime, setLifetime] = useLifetimeUsage(sessionReady ? accountScope : null)
  const live = Boolean(sessionReady && accountScope && canRunLive(status.data, settings))
  const cloudAvailable = Boolean(
    sessionReady && accountScope && accountScope !== "anonymous" && status.data?.databaseConfigured,
  )
  const memory = useMemories(cloudAvailable, accountScope, authRevision)

  const voice = useCzechVoice((text) => setInput(text))

  useEffect(() => {
    if (view === "command" && hint?.includes("ikonu mikrofonu")) {
      let secondFrame = 0
      const timeout = window.setTimeout(() => {
        secondFrame = window.requestAnimationFrame(() => inputRef.current?.focus())
      }, 120)
      return () => {
        window.clearTimeout(timeout)
        if (secondFrame) window.cancelAnimationFrame(secondFrame)
      }
    }
  }, [hint, view])

  const { state: run, startLive, startDemo, cancel, reset } = useJarvisRun({
    onLiveComplete: ({ prompt, answer, usage }) => {
      if (!sessionReady || !accountScope) return
      setLifetime((l) => ({
        runs: l.runs + 1,
        promptTokens: l.promptTokens + usage.promptTokens,
        completionTokens: l.completionTokens + usage.completionTokens,
        costUsd: l.costUsd + usage.costUsd,
      }))
      if (settings.autoHistory && answer) memory.addHistory(prompt, answer)
      if (settings.speakAnswers && answer) voice.speak(answer)
      status.mutate()
    },
  })

  const beginSessionCheck = useCallback(() => {
    ++authRequestRef.current
    authAbortRef.current?.abort()
    setAuthPending(true)
    setAuthError(false)
    cancel()
    voice.abortListening()
    voice.stopSpeaking()
  }, [cancel, voice.abortListening, voice.stopSpeaking])

  const refreshSession = useCallback(() => {
    beginSessionCheck()
    const request = authRequestRef.current
    const controller = new AbortController()
    authAbortRef.current = controller
    void (async () => {
      try {
        const response = await fetch("/api/status", { cache: "no-store", signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json() as StatusResponse
        if (controller.signal.aborted || request !== authRequestRef.current) return
        if (data.authenticated && !data.accountScope) throw new Error("Chybí identifikátor účtu.")
        await status.mutate(data, { revalidate: false })
        if (!controller.signal.aborted && request === authRequestRef.current) setAuthPending(false)
      } catch {
        if (!controller.signal.aborted && request === authRequestRef.current) setAuthError(true)
      }
    })()
  }, [beginSessionCheck, status.mutate])

  useEffect(() => {
    return () => authAbortRef.current?.abort()
  }, [])

  useEffect(() => {
    if (status.error && !authPending) refreshSession()
  }, [authPending, refreshSession, status.error])

  useEffect(() => {
    if (status.data?.authenticated && !status.data.accountScope && !authPending) refreshSession()
  }, [authPending, refreshSession, status.data])

  useEffect(() => {
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("vobio-jarvis-auth")
    if (channel) channel.onmessage = (event) => {
      if (event.data === "session-changed") refreshSession()
    }
    let suspended = false
    const suspend = () => {
      if (!suspended) {
        suspended = true
        beginSessionCheck()
      }
    }
    const resume = () => {
      if (suspended && document.visibilityState === "visible" && document.hasFocus()) {
        suspended = false
        refreshSession()
      }
    }
    const onVisibility = () => document.visibilityState === "hidden" ? suspend() : resume()
    const onStorage = (event: StorageEvent) => {
      if (event.key === "vobio-jarvis.auth-change" && event.newValue) refreshSession()
    }
    window.addEventListener("storage", onStorage)
    window.addEventListener("blur", suspend)
    window.addEventListener("focus", resume)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      channel?.close()
      window.removeEventListener("storage", onStorage)
      window.removeEventListener("blur", suspend)
      window.removeEventListener("focus", resume)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [beginSessionCheck, refreshSession])

  useEffect(() => {
    if (!resolvedScope) return
    if (previousScopeRef.current && previousScopeRef.current !== resolvedScope) {
      setInput("")
      reset()
      setAuthRevision((revision) => revision + 1)
      voice.abortListening()
      voice.stopSpeaking()
    }
    previousScopeRef.current = resolvedScope
  }, [resolvedScope, reset, voice.abortListening, voice.stopSpeaking])

  const running = run.phase === "running"

  const submit = useCallback(() => {
    const message = input.trim()
    if (message.length < 2) return
    voice.stopListening()
    setView("orchestration")
    if (!live) {
      startDemo(message, settings.demoLoop)
      return
    }
    const memories = memory.items
      .filter((m) => settings.useSensitiveInContext || !m.sensitive)
      .map(({ id, category, title, content }) => ({ id, category, title, content }))
    startLive({
      message,
      mode: settings.mode,
      depth: settings.depth,
      model: settings.model,
      reasoning: settings.reasoning,
      enabledAgents: settings.enabledAgents,
      budget: { maxTokens: settings.maxTokens, maxCostUsd: settings.maxCostUsd },
      memories,
    })
    setInput("")
  }, [input, live, memory.items, settings, startDemo, startLive, voice])

  const handleMic = useCallback(() => {
    if (voice.listening) {
      voice.stopListening()
      return
    }
    const started = voice.startListening()
    if (!started) {
      setHint("Klepněte do pole a použijte ikonu mikrofonu na klávesnici iPhonu (diktování).")
      setView("command")
      window.setTimeout(() => inputRef.current?.focus(), 80)
    } else {
      setHint(null)
    }
  }, [voice])

  const activeAgent = (Object.keys(run.agents) as AgentId[]).find((id) => run.agents[id].status === "thinking")
  const coreLabel = running ? (run.source === "demo" ? "Simulace" : "Zpracovávám") : run.phase === "done" ? "Hotovo" : "Připraven"
  const coreSub = running
    ? activeAgent
      ? `${AGENTS[activeAgent].name}: ${run.agents[activeAgent].activity}`
      : "Koordinuji tým"
    : live
      ? `${settings.depth === "quick" ? "Rychlá analýza" : "Celý tým"} · ${settings.model}`
      : "Bez volání API"

  return (
    <>
    <div
      className={cn("relative min-h-dvh overflow-x-hidden", !sessionReady && "invisible")}
      aria-hidden={!sessionReady}
      inert={!sessionReady}
    >
      <div aria-hidden="true" className="hud-grid pointer-events-none fixed inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_75%)]" />
      <div aria-hidden="true" className="pointer-events-none fixed -top-40 left-1/2 h-96 w-[36rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />

      <header className="pt-safe relative z-10">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.35em] text-muted-foreground">Jan Vobora</p>
            <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
              VOBIO <span className="text-primary">JARVIS</span>
            </h1>
          </div>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className={cn(
              "flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-3 font-mono text-[11px] font-semibold uppercase tracking-wider",
              live ? "border-primary/40 bg-primary/10 text-primary" : "border-warning/50 bg-warning/10 text-warning",
            )}
            aria-label={live ? "Živý režim – otevřít nastavení" : "Demo režim – otevřít nastavení"}
          >
            <span className={cn("size-2 rounded-full", live ? "bg-primary shadow-[0_0_8px_#22d3ee]" : "bg-warning")} aria-hidden="true" />
            {live ? "Živě" : "Demo režim"}
          </button>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-3xl px-4 pb-36">
        {!live && sessionReady && status.data && (
          <DemoNotice
            reason={
              !status.data.liveEnabled
                ? "Živý AI backend čeká na schválení designu."
                : !status.data.deepseekConfigured
                ? "DeepSeek API klíč není na serveru nastaven."
                : !status.data.authConfigured
                  ? "Chybí přístupový kód JARVIS_ACCESS_CODE."
                  : !status.data.authenticated
                    ? "Pro živý režim se přihlaste v Nastavení."
                    : "Živý režim je vypnutý v Nastavení."
            }
            onOpen={() => setSettingsOpen(true)}
          />
        )}

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view}
            initial={{ opacity: 0, y: reduce ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.2 }}
            className="space-y-5"
          >
            {view === "command" && (
              <>
                <HudCore active={running} label={coreLabel} sublabel={coreSub} className="mt-2" />
                <Composer
                  ref={inputRef}
                  value={input}
                  onChange={setInput}
                  onSubmit={submit}
                  onStop={cancel}
                  running={running}
                  mode={settings.mode}
                  onModeChange={(m) => setSettings((s) => ({ ...s, mode: m }))}
                  listening={voice.listening}
                  onMic={handleMic}
                  isDemo={!live}
                  autoFocus={Boolean(hint?.includes("ikonu mikrofonu"))}
                />
                {(voice.error || hint) && <p role="status" className="rounded-2xl bg-secondary/70 p-3 text-sm text-muted-foreground">{voice.error ?? hint}</p>}
                {voice.listening && <p role="status" className="text-center text-sm text-primary">Poslouchám… mluvte česky</p>}
                <ResultPanel run={run} speaking={voice.speaking} canSpeak={voice.synthesisSupported} onSpeak={voice.speak} onStopSpeaking={voice.stopSpeaking} />
                <QuickStats lifetimeCost={lifetime.costUsd} runs={lifetime.runs} memoryCount={memory.items.length} live={live} />
              </>
            )}

            {view === "agents" && (
              <section className="space-y-4">
                <ScreenHeading eyebrow="Tým agentů" title="Sedm cílových rolí" detail="Router, Researcher, Architect, Coder, Analyst, Critic a Final Judge. Pomocná paměť zůstává kvůli kompatibilitě." />
                <SpatialVisualization kind="agents" run={run} onInspect={setInspect} />
                <AgentCanvas run={run} onInspect={setInspect} />
                <ResultPanel run={run} speaking={voice.speaking} canSpeak={voice.synthesisSupported} onSpeak={voice.speak} onStopSpeaking={voice.stopSpeaking} />
              </section>
            )}

            {view === "development" && <DevelopmentStudioScreen key={`${authRevision}:${status.data?.accountScope ?? "anonymous"}`} />}

            {view === "orchestration" && (
              <section className="space-y-4">
                <ScreenHeading eyebrow="Orchestrace" title="Tok práce v reálném čase" detail={run.rationale || "Spusťte ukázku z Velínu a sledujte koordinaci sedmi rolí."} />
                {run.plan.length > 0 && <ol className="space-y-2">{run.plan.map((item, index) => <li key={item.agent} className="glass flex gap-3 rounded-2xl p-3"><span className="font-mono text-primary">{String(index + 1).padStart(2, "0")}</span><div><p className="text-sm font-medium">{AGENTS[item.agent].name}</p><p className="text-xs text-muted-foreground">{item.task}</p></div></li>)}</ol>}
                <AgentCanvas run={run} onInspect={setInspect} />
                {running ? <button type="button" onClick={cancel} className="min-h-11 rounded-full bg-destructive/90 px-4 text-sm font-medium text-white">Zastavit běh</button> : <button type="button" onClick={() => startDemo("Ukázková vizualizace týmu agentů", settings.demoLoop)} className="min-h-11 rounded-full border border-warning/50 px-4 text-sm font-medium text-warning">Spustit vizuální DEMO</button>}
                <ResultPanel run={run} speaking={voice.speaking} canSpeak={voice.synthesisSupported} onSpeak={voice.speak} onStopSpeaking={voice.stopSpeaking} />
              </section>
            )}

            {view === "projects" && <ProjectsScreen onUse={(project: JarvisProject) => { setInput(project.prompt); setView("command"); window.setTimeout(() => inputRef.current?.focus(), 0) }} />}
            {view === "automations" && <AutomationsScreen />}
            {view === "voice" && <VoiceScreen listening={voice.listening} speaking={voice.speaking} supported={voice.recognitionSupported} canSpeak={voice.synthesisSupported} error={voice.error ?? hint} onMic={handleMic} onSpeak={() => voice.speak("Dobrý den, JARVIS je připraven. Hlasové ovládání se spouští pouze po vašem klepnutí.")} onStop={voice.stopSpeaking} />}
            {view === "approvals" && accountScope && <ApprovalsScreen key={`${authRevision}:${accountScope}`} />}
            {view === "memory" && <MemoryScreen items={memory.items} cloudAvailable={cloudAvailable} onOpen={() => setMemoryOpen(true)} />}
            {view === "analytics" && <AnalyticsScreen lifetime={lifetime} status={sessionReady ? status.data : undefined} run={run} />}
            {view === "settings" && <SettingsScreen settings={settings} liveEnabled={Boolean(sessionReady && status.data?.liveEnabled)} onOpen={() => setSettingsOpen(true)} />}
          </motion.div>
        </AnimatePresence>
      </main>

      <BottomNav view={view} onView={setView} running={running} />

      <AgentInspector agentId={inspect} run={run} onClose={() => setInspect(null)} />
      {accountScope && <MemoryDrawer
        key={`memory:${authRevision}:${accountScope}`}
        open={memoryOpen}
        onClose={() => setMemoryOpen(false)}
        memory={memory}
        cloudAvailable={cloudAvailable}
        cloudReason={
          status.data?.databaseConfigured
            ? "Databáze je nastavena – přihlaste se pro synchronizaci a citlivé položky."
            : "Položky se ukládají jen v tomto zařízení. Pro synchronizaci nastavte DATABASE_URL (PostgreSQL)."
        }
      />}
      <SettingsDrawer
        key={`settings:${authRevision}:${accountScope ?? "pending"}`}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        setSettings={setSettings}
        status={sessionReady ? status.data : undefined}
        statusError={Boolean(status.error)}
        onStatusChange={() => {
          refreshSession()
          try {
            localStorage.setItem("vobio-jarvis.auth-change", crypto.randomUUID())
          } catch {
            console.warn("Změnu relace nelze oznámit přes úložiště prohlížeče.")
          }
          if (typeof BroadcastChannel !== "undefined") {
            const channel = new BroadcastChannel("vobio-jarvis-auth")
            channel.postMessage("session-changed")
            channel.close()
          }
        }}
        lifetime={lifetime}
        onResetLifetime={() => setLifetime({ runs: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 })}
        onPlayDemo={() => {
          setSettingsOpen(false)
          setView("orchestration")
          startDemo("Ukázková vizualizace týmu agentů", settings.demoLoop)
        }}
        voiceSupport={{ recognition: voice.recognitionSupported, synthesis: voice.synthesisSupported }}
      />
    </div>
    {!sessionReady && (
      <div
        role={authError ? "alert" : "status"}
        className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 p-4 text-center"
      >
        <div className="max-w-sm space-y-3">
          <p className="text-sm text-muted-foreground">
            {authError
              ? "Stav přihlášení nelze ověřit. Údaje účtu zůstávají skryté."
              : "Ověřuji relaci. Údaje účtu zůstávají skryté."}
          </p>
          {authError && <button type="button" onClick={refreshSession} className="min-h-11 rounded-full border px-4 underline">Zkusit znovu</button>}
        </div>
      </div>
    )}
    </>
  )
}

function ScreenHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return <header className="space-y-1"><p className="font-mono text-[10px] uppercase tracking-[0.3em] text-primary">{eyebrow}</p><h2 className="text-xl font-semibold tracking-tight">{title}</h2><p className="text-sm leading-relaxed text-muted-foreground">{detail}</p></header>
}

function DemoNotice({ reason, onOpen }: { reason: string; onOpen: () => void }) {
  return (
    <div className="mb-2 flex items-center gap-3 rounded-2xl border border-warning/40 bg-warning/10 p-3">
      <p className="min-w-0 flex-1 text-sm text-warning">
        <span className="font-semibold">DEMO REŽIM.</span> {reason} Žádná skutečná volání API.
      </p>
      <button type="button" onClick={onOpen} className="min-h-11 shrink-0 rounded-full bg-warning/20 px-3 text-sm font-medium text-warning">
        Nastavit
      </button>
    </div>
  )
}

function QuickStats({ lifetimeCost, runs, memoryCount, live }: { lifetimeCost: number; runs: number; memoryCount: number; live: boolean }) {
  return (
    <dl className="grid grid-cols-3 gap-2">
      {[
        { label: "Živé běhy", value: String(runs) },
        { label: "Útrata (odhad)", value: formatUsd(lifetimeCost) },
        { label: "Položky paměti", value: String(memoryCount) },
      ].map((s) => (
        <div key={s.label} className="glass rounded-2xl p-3 text-center">
          <dt className="text-[11px] text-muted-foreground">{s.label}</dt>
          <dd className={cn("mt-0.5 font-mono text-base", live ? "text-foreground" : "text-muted-foreground")}>{s.value}</dd>
        </div>
      ))}
    </dl>
  )
}
