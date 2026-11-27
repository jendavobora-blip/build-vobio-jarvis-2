"use client"

import { BarChart3, Cloud, HardDrive, LockKeyhole, Mic, Pause, Play, Settings2, ShieldCheck, Sparkles } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLocalState } from "@/lib/jarvis/local-store"
import { filterProjects, PROJECTS, type JarvisProject } from "@/lib/jarvis/projects"
import { formatUsd } from "@/lib/jarvis/pricing"
import type { JarvisSettings, LifetimeUsage } from "@/hooks/use-jarvis-settings"
import type { MemoryItem, StatusResponse } from "@/lib/jarvis/types"
import type { RunState } from "@/lib/jarvis/run-state"
import { cn } from "@/lib/utils"

const CATEGORIES = ["Vše", "AI", "Byznys", "Produktivita", "Výzkum"]

export function ProjectsScreen({ onUse }: { onUse: (project: JarvisProject) => void }) {
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState("Vše")
  const filtered = useMemo(() => filterProjects(query, category), [query, category])

  return (
    <section className="space-y-4">
      <ScreenIntro eyebrow="Katalog projektů" title={`${PROJECTS.length} připravených startů`} detail="Lokální ukázkový katalog. Výběr pouze předvyplní zadání; nic se nespouští automaticky." />
      <label className="block">
        <span className="sr-only">Hledat projekty</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat projekt…" className="min-h-12 w-full rounded-2xl border border-input bg-card px-4 text-base outline-none focus:border-primary" />
      </label>
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="Kategorie projektů">
        {CATEGORIES.map((item) => (
          <button key={item} type="button" aria-pressed={category === item} onClick={() => setCategory(item)} className={cn("min-h-10 shrink-0 rounded-full px-3 text-xs font-medium", category === item ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground")}>{item}</button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {filtered.map((project) => (
          <article key={project.id} className="glass flex min-h-44 flex-col rounded-2xl p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-primary">{project.category}</span>
              <Sparkles className="size-4 text-primary/70" aria-hidden="true" />
            </div>
            <h3 className="mt-2 font-semibold">{project.name}</h3>
            <p className="mt-1 flex-1 text-sm text-muted-foreground">{project.description}</p>
            <button type="button" onClick={() => onUse(project)} className="mt-4 min-h-11 rounded-xl border border-primary/30 px-3 text-sm font-medium text-primary hover:bg-primary/10">Použít jako zadání</button>
          </article>
        ))}
      </div>
      {filtered.length === 0 && <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Žádný projekt neodpovídá hledání.</p>}
    </section>
  )
}

interface Automation {
  id: string
  title: string
  detail: string
  enabled: boolean
}

const DEFAULT_AUTOMATIONS: Automation[] = [
  { id: "morning", title: "Ranní přehled", detail: "Návrh souhrnu úkolů · pouze lokální plán", enabled: false },
  { id: "weekly", title: "Týdenní revize", detail: "Kontrola projektů a otevřených rozhodnutí", enabled: false },
  { id: "memory", title: "Úklid paměti", detail: "Připomenutí duplicit a zastaralého kontextu", enabled: false },
]

export function AutomationsScreen() {
  const [automations, setAutomations] = useLocalState<Automation[]>("vobio-jarvis.automations.v1", DEFAULT_AUTOMATIONS)
  return (
    <section className="space-y-4">
      <ScreenIntro eyebrow="Automatizace" title="Připravené rutiny" detail="Tato etapa ukládá jen lokální přepínače. Žádné plánované úlohy, externí akce ani placené služby neběží." />
      <div className="space-y-3">
        {automations.map((automation) => (
          <label key={automation.id} className="glass flex min-h-20 cursor-pointer items-center gap-3 rounded-2xl p-4">
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{automation.title}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{automation.detail}</span>
            </span>
            <input type="checkbox" role="switch" checked={automation.enabled} onChange={(event) => setAutomations((current) => current.map((item) => item.id === automation.id ? { ...item, enabled: event.target.checked } : item))} className="size-5 accent-[#22d3ee]" />
          </label>
        ))}
      </div>
      <div className="rounded-2xl border border-warning/30 bg-warning/5 p-4 text-sm text-muted-foreground">Přepínače jsou pouze návrhem UX. Zapnutí zde nepovoluje přístup k AI, kalendáři, e-mailu ani jiným službám.</div>
    </section>
  )
}

export function VoiceScreen({ listening, speaking, supported, canSpeak, error, onMic, onSpeak, onStop }: {
  listening: boolean
  speaking: boolean
  supported: boolean
  canSpeak: boolean
  error: string | null
  onMic: () => void
  onSpeak: () => void
  onStop: () => void
}) {
  return (
    <section className="space-y-4">
      <ScreenIntro eyebrow="Hlasové rozhraní" title="Čeština · cs-CZ" detail="Mikrofon se aktivuje pouze po klepnutí. Rozpoznávání řeči zajišťuje prohlížeč; dostupnost se liší podle zařízení." />
      <div className="glass space-y-4 rounded-3xl p-5 text-center">
        <div className={cn("mx-auto flex size-24 items-center justify-center rounded-full border", listening ? "border-destructive bg-destructive/10 text-destructive" : "border-primary/40 bg-primary/10 text-primary")}>
          <Mic className="size-9" aria-hidden="true" />
        </div>
        <p className="text-sm text-muted-foreground">{listening ? "Poslouchám… mluvte česky" : supported ? "Hlasový vstup je připraven" : "Rozpoznávání není podporováno; použijte diktování klávesnice."}</p>
        <button type="button" onClick={onMic} className={cn("min-h-12 w-full rounded-2xl font-semibold", listening ? "bg-destructive text-white" : "bg-primary text-primary-foreground")}>{listening ? "Zastavit mikrofon" : "Začít diktovat"}</button>
        {error && <p role="status" className="text-sm text-warning">{error}</p>}
      </div>
      <div className="glass flex items-center justify-between gap-3 rounded-2xl p-4">
        <div><p className="font-medium">Test českého předčítání</p><p className="text-xs text-muted-foreground">{canSpeak ? "Používá hlas dostupný v systému." : "Syntéza řeči není v tomto prohlížeči podporována."}</p></div>
        <button type="button" disabled={!canSpeak} onClick={speaking ? onStop : onSpeak} className="flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-secondary px-3 text-sm disabled:opacity-40">{speaking ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}{speaking ? "Zastavit" : "Přehrát"}</button>
      </div>
    </section>
  )
}

interface ApprovalItem {
  id: string
  plan_hash: string
  plan_json: string
  status: "pending" | "critical_reviewed" | "approved" | "denied" | "executed"
  created_at: string
}

interface ApprovalAuditItem {
  approval_id: string
  event: string
  created_at: string
}

export function ApprovalsScreen() {
  const [items, setItems] = useState<ApprovalItem[]>([])
  const [audit, setAudit] = useState<ApprovalAuditItem[]>([])
  const [target, setTarget] = useState("")
  const [action, setAction] = useState("")
  const [changes, setChanges] = useState("")
  const [impacts, setImpacts] = useState("")
  const [critical, setCritical] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const requests = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    const signal = requests.current?.signal
    if (!signal || signal.aborted) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetch("/api/approvals", { cache: "no-store", signal })
      const body = await response.json()
      if (signal.aborted) return
      if (!response.ok) throw new Error(body.error ?? "Schválení nelze načíst.")
      setItems(body.items)
      setAudit(body.audit)
    } catch (reason) {
      if (signal.aborted) return
      setError(reason instanceof Error ? reason.message : "Schválení nelze načíst.")
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    requests.current = new AbortController()
    void refresh()
    return () => requests.current?.abort()
  }, [refresh])

  const submitPlan = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const signal = requests.current?.signal
    if (!signal || signal.aborted) return
    setMessage(null)
    setError(null)
    try {
      const response = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: target.trim(),
          action: action.trim(),
          changes: changes.split("\n").map((item) => item.trim()).filter(Boolean),
          impacts: impacts.split("\n").map((item) => item.trim()).filter(Boolean),
          critical,
        }),
        signal,
      })
      const body = await response.json()
      if (signal.aborted) return
      if (!response.ok) throw new Error(body.error ?? "Plán nelze uložit.")
      setTarget("")
      setAction("")
      setChanges("")
      setImpacts("")
      setCritical(false)
      setMessage("Neměnný plán byl uložen. Žádná externí akce nebyla provedena.")
      await refresh()
    } catch (reason) {
      if (signal.aborted) return
      setError(reason instanceof Error ? reason.message : "Plán nelze uložit.")
    }
  }

  const decide = async (item: ApprovalItem, decision: "approve" | "confirm_critical" | "deny") => {
    const signal = requests.current?.signal
    if (!signal || signal.aborted) return
    setMessage(null)
    setError(null)
    try {
      const response = await fetch("/api/approvals", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, planHash: item.plan_hash, decision }),
        signal,
      })
      const body = await response.json()
      if (signal.aborted) return
      if (!response.ok) throw new Error(body.error ?? "Rozhodnutí nelze uložit.")
      setMessage("Souhlas byl zaznamenán. JARVIS neprovádí externí akce.")
      await refresh()
    } catch (reason) {
      if (signal.aborted) return
      setError(reason instanceof Error ? reason.message : "Rozhodnutí nelze uložit.")
    }
  }

  return (
    <section className="space-y-4">
      <ScreenIntro eyebrow="Autonomie C" title="Schválení konkrétních plánů" detail="Souhlas se váže na přesný hash plánu a změna plánu vyžaduje nové schválení. Tato verze zaznamenává souhlas, ale nespouští externí akce." />
      <button type="button" onClick={refresh} disabled={loading} className="min-h-11 rounded-xl bg-secondary px-4 text-sm font-medium disabled:opacity-50">{loading ? "Načítám…" : "Načíst plány a audit"}</button>
      <form onSubmit={submitPlan} className="glass space-y-3 rounded-2xl p-4">
        <h3 className="font-semibold">Předložit přesný plán</h3>
        <label className="block text-sm">Cílový systém<input required maxLength={200} value={target} onChange={(event) => setTarget(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-input bg-background px-3" /></label>
        <label className="block text-sm">Akce<input required maxLength={200} value={action} onChange={(event) => setAction(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-input bg-background px-3" /></label>
        <label className="block text-sm">Změny (každá na samostatný řádek)<textarea required value={changes} onChange={(event) => setChanges(event.target.value)} className="mt-1 min-h-20 w-full rounded-xl border border-input bg-background p-3" /></label>
        <label className="block text-sm">Dopady (každý na samostatný řádek)<textarea required value={impacts} onChange={(event) => setImpacts(event.target.value)} className="mt-1 min-h-20 w-full rounded-xl border border-input bg-background p-3" /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={critical} onChange={(event) => setCritical(event.target.checked)} className="size-5 accent-primary" />Kritická akce (platba, mazání, oprávnění nebo produkce)</label>
        <button type="submit" className="min-h-11 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground">Předložit ke schválení</button>
      </form>
      {error && <p role="alert" className="rounded-xl border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}
      {message && <p role="status" className="rounded-xl border border-primary/30 p-3 text-sm">{message}</p>}
      <div className="space-y-3">
        {items.map((item) => {
          const plan = JSON.parse(item.plan_json) as { target: string; action: string; changes: string[]; impacts: string[]; critical: boolean }
          return (
            <article key={item.id} className="glass space-y-3 rounded-2xl p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold">{plan.action}</h3>
                <span className="rounded-full bg-secondary px-3 py-1 text-xs">{item.status}</span>
              </div>
              <p className="text-sm text-muted-foreground">Cíl: {plan.target}</p>
              <p className="text-xs text-muted-foreground">Hash plánu: <code>{item.plan_hash}</code></p>
              <div className="text-sm"><p className="font-medium">Změny</p><ul className="ml-5 list-disc">{plan.changes.map((change) => <li key={change}>{change}</li>)}</ul></div>
              <div className="text-sm"><p className="font-medium">Dopady</p><ul className="ml-5 list-disc">{plan.impacts.map((impact) => <li key={impact}>{impact}</li>)}</ul></div>
              {item.status === "pending" && <div className="flex gap-2"><button type="button" onClick={() => decide(item, "approve")} className="min-h-10 rounded-xl bg-primary px-3 text-sm text-primary-foreground">Schválit plán</button><button type="button" onClick={() => decide(item, "deny")} className="min-h-10 rounded-xl bg-secondary px-3 text-sm">Zamítnout</button></div>}
              {item.status === "critical_reviewed" && <div className="rounded-xl border border-warning/40 p-3"><p className="mb-2 text-sm">Kritická akce vyžaduje samostatné druhé potvrzení.</p><div className="flex gap-2"><button type="button" onClick={() => decide(item, "confirm_critical")} className="min-h-10 rounded-xl bg-warning px-3 text-sm">Potvrdit kritickou akci</button><button type="button" onClick={() => decide(item, "deny")} className="min-h-10 rounded-xl bg-secondary px-3 text-sm">Zamítnout</button></div></div>}
              {item.status === "approved" && <p className="text-sm text-primary"><ShieldCheck className="mr-1 inline size-4" aria-hidden="true" />Souhlas zaznamenán; bez připojeného schváleného nástroje se nic neprovede.</p>}
            </article>
          )
        })}
        {items.length === 0 && !loading && <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">Zatím nejsou žádné schvalovací plány. Databáze a přihlášení jsou nutné pro ukládání.</p>}
      </div>
      <details className="glass rounded-2xl p-4">
        <summary className="cursor-pointer font-semibold">Auditní záznamy ({audit.length})</summary>
        <ol className="mt-3 space-y-2 text-sm">{audit.map((entry, index) => <li key={`${entry.approval_id}-${entry.event}-${index}`} className="border-t border-border pt-2">{entry.event} · plán {entry.approval_id} · {new Date(entry.created_at).toLocaleString("cs-CZ")}</li>)}</ol>
      </details>
    </section>
  )
}

export function MemoryScreen({ items, cloudAvailable, onOpen }: { items: MemoryItem[]; cloudAvailable: boolean; onOpen: () => void }) {
  return (
    <section className="space-y-4">
      <ScreenIntro eyebrow="Paměť JARVISe" title={`${items.length} položek`} detail="Obsah zůstává pod vaší kontrolou. Model se tím nepřetrénovává; položky se použijí jen jako kontext." />
      <div className="glass flex items-center gap-3 rounded-2xl p-4">
        {cloudAvailable ? <Cloud className="size-5 text-success" aria-hidden="true" /> : <HardDrive className="size-5 text-muted-foreground" aria-hidden="true" />}
        <div><p className="text-sm font-medium">{cloudAvailable ? "Synchronizace dostupná" : "Pouze toto zařízení"}</p><p className="text-xs text-muted-foreground">{cloudAvailable ? "Citlivé položky lze uložit šifrovaně." : "Cloudová paměť není připojena."}</p></div>
      </div>
      <button type="button" onClick={onOpen} className="min-h-12 w-full rounded-2xl bg-primary font-semibold text-primary-foreground">Spravovat paměť</button>
      {items.length > 0 ? <ul className="space-y-2">{items.slice(0, 5).map((item) => <li key={item.id} className="glass rounded-2xl p-3"><p className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">{item.sensitive && <LockKeyhole className="size-3 text-warning" aria-label="Citlivé" />}{item.category}</p><p className="mt-1 font-medium">{item.title}</p><p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{item.content}</p></li>)}</ul> : <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Paměť je zatím prázdná.</p>}
    </section>
  )
}

export function AnalyticsScreen({ lifetime, status, run }: { lifetime: LifetimeUsage; status?: StatusResponse; run: RunState }) {
  const stats = [
    { label: "Počet běhů", value: String(lifetime.runs) },
    { label: "Tokeny", value: (lifetime.promptTokens + lifetime.completionTokens).toLocaleString("cs-CZ") },
    { label: "Odhad nákladů", value: formatUsd(lifetime.costUsd) },
    { label: "Dnes na serveru", value: status?.usageToday ? formatUsd(status.usageToday.costUsd) : "—" },
  ]
  return (
    <section className="space-y-4">
      <ScreenIntro eyebrow="Analytika" title="Přehled využití" detail="Lokální statistiky jsou uloženy v zařízení; serverové údaje jsou dostupné jen po přihlášení." />
      <div className="grid grid-cols-2 gap-3">{stats.map((stat) => <div key={stat.label} className="glass rounded-2xl p-4"><p className="text-xs text-muted-foreground">{stat.label}</p><p className="mt-2 font-mono text-xl text-primary">{stat.value}</p></div>)}</div>
      <div className="glass flex items-center gap-3 rounded-2xl p-4"><BarChart3 className="size-5 text-primary" aria-hidden="true" /><p className="text-sm text-muted-foreground">{run.phase === "running" ? "Právě probíhá běh." : "V této etapě se nevykreslují smyšlené grafy ani odhadované živé metriky."}</p></div>
    </section>
  )
}

export function SettingsScreen({ settings, liveEnabled, onOpen }: { settings: JarvisSettings; liveEnabled: boolean; onOpen: () => void }) {
  return (
    <section className="space-y-4">
      <ScreenIntro eyebrow="Nastavení" title="Soukromí a ovládání" detail="Živé volání API zůstává zablokované, dokud není na serveru výslovně povoleno." />
      <div className="glass space-y-3 rounded-2xl p-4">
        <SettingRow label="Živý AI backend" value={liveEnabled ? "Server jej povolil" : "Vypnuto do schválení designu"} accent={!liveEnabled} />
        <SettingRow label="Aktivní agenti" value={`${settings.enabledAgents.length} / 6 specialistů`} />
        <SettingRow label="Hlasové odpovědi" value={settings.speakAnswers ? "Zapnuto" : "Vypnuto"} />
        <SettingRow label="Historie běhů" value={settings.autoHistory ? "Ukládá se lokálně" : "Vypnuto"} />
      </div>
      <button type="button" onClick={onOpen} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-primary font-semibold text-primary-foreground"><Settings2 className="size-4" aria-hidden="true" />Otevřít podrobné nastavení</button>
      <p className="flex items-start gap-2 rounded-2xl border border-border p-4 text-xs text-muted-foreground"><LockKeyhole className="mt-0.5 size-4 shrink-0" aria-hidden="true" />Klíče zůstávají pouze v serverových proměnných. Rozhraní nikdy nezobrazuje jejich hodnoty.</p>
    </section>
  )
}

function ScreenIntro({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return <header className="space-y-1"><p className="font-mono text-[10px] uppercase tracking-[0.3em] text-primary">{eyebrow}</p><h2 className="text-xl font-semibold tracking-tight">{title}</h2><p className="text-sm leading-relaxed text-muted-foreground">{detail}</p></header>
}

function SettingRow({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className="flex items-center justify-between gap-3 border-b border-border/70 pb-3 last:border-0 last:pb-0"><span className="text-sm text-muted-foreground">{label}</span>  <span className={cn("flex items-center gap-1.5 text-right text-xs font-medium", accent ? "text-warning" : "text-foreground")}>{accent && <LockKeyhole className="size-3" aria-hidden="true" />}{value}</span></div>
}
