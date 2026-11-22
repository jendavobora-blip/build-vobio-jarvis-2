"use client"

import { CheckCircle2, CircleSlash, LogIn, LogOut, RotateCcw } from "lucide-react"
import { useState } from "react"
import { SlideOver } from "./slide-over"
import { AGENTS, SPECIALISTS } from "@/lib/jarvis/agents"
import { formatUsd, MODEL_LABELS } from "@/lib/jarvis/pricing"
import type { JarvisSettings, LifetimeUsage } from "@/hooks/use-jarvis-settings"
import type { ModelId, StatusResponse } from "@/lib/jarvis/types"
import { cn } from "@/lib/utils"

interface SettingsDrawerProps {
  open: boolean
  onClose: () => void
  settings: JarvisSettings
  setSettings: (next: JarvisSettings | ((p: JarvisSettings) => JarvisSettings)) => void
  status: StatusResponse | undefined
  statusError: boolean
  onStatusChange: () => void
  lifetime: LifetimeUsage
  onResetLifetime: () => void
  onPlayDemo: () => void
  voiceSupport: { recognition: boolean; synthesis: boolean }
}

export function SettingsDrawer(props: SettingsDrawerProps) {
  const { open, onClose, settings, setSettings, status, statusError, lifetime } = props
  const patch = (p: Partial<JarvisSettings>) => setSettings((s) => ({ ...s, ...p }))
  const liveReady = Boolean(status?.liveEnabled && status.deepseekConfigured && status.authConfigured)

  return (
    <SlideOver open={open} onClose={onClose} title="Nastavení" description="Připojení, agenti, rozpočet a zabezpečení.">
      <div className="space-y-6">
        <Section title="Připojení">
          {statusError && (
            <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
              Stav serveru nelze načíst.
            </p>
          )}
          <StatusRow ok={Boolean(status?.deepseekConfigured)} label="DeepSeek API" detail={status?.deepseekConfigured ? "Klíč je nastaven na serveru" : "Chybí DEEPSEEK_API_KEY"} />
          <StatusRow ok={Boolean(status?.liveEnabled)} label="Povolení živého backendu" detail={status?.liveEnabled ? "Serverový přepínač je zapnutý" : "Zablokováno do schválení designu"} />
          <StatusRow ok={Boolean(status?.authConfigured)} label="Přihlášení" detail={status?.authConfigured ? "Přístupový kód je nastaven" : "Chybí JARVIS_ACCESS_CODE (min. 8 znaků)"} />
          <StatusRow ok={Boolean(status?.authenticated)} label="Relace" detail={status?.authenticated ? "Přihlášeno" : "Nepřihlášeno"} />
          <StatusRow ok={Boolean(status?.databaseConfigured)} label="Databáze (volitelná)" detail={status?.databaseConfigured ? "DATABASE_URL nastavena" : "Paměť jen v tomto zařízení"} optional />
          {status?.authConfigured && <AuthBox authenticated={status.authenticated} onChange={props.onStatusChange} />}
        </Section>

        <Section title="Režim">
          <Toggle
            label="Živý režim (skutečná volání DeepSeek)"
            hint={liveReady ? (status?.authenticated ? "Vypnutím přejdete do DEMO REŽIMU." : "Nejprve se přihlaste.") : "Nedostupné – čeká na schválení designu a povolení serveru."}
            checked={settings.liveMode && liveReady}
            disabled={!liveReady}
            onChange={(v) => patch({ liveMode: v })}
          />
          <Toggle label="Smyčka ukázkové animace" hint="Jen vizuální DEMO, žádná volání API." checked={settings.demoLoop} onChange={(v) => patch({ demoLoop: v })} />
          <button type="button" onClick={props.onPlayDemo} className="min-h-11 w-full rounded-xl border border-warning/40 text-sm font-medium text-warning">
            Spustit ukázku (DEMO)
          </button>
        </Section>

        <Section title="Model a analýza">
          <div className="grid gap-2">
            {(Object.keys(MODEL_LABELS) as ModelId[]).map((m) => (
              <Choice key={m} selected={settings.model === m} onClick={() => patch({ model: m })} label={MODEL_LABELS[m]} />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Choice selected={settings.depth === "quick"} onClick={() => patch({ depth: "quick" })} label="Rychlá" sub="max. 3 specialisté" />
            <Choice selected={settings.depth === "full"} onClick={() => patch({ depth: "full" })} label="Celý tým" sub="všech 7 agentů" />
          </div>
          <Toggle
            label="Hloubkové uvažování (thinking)"
            hint="Přesnější, ale výrazně více tokenů."
            checked={settings.reasoning}
            onChange={(v) => patch({ reasoning: v })}
          />
        </Section>

        <Section title="Agenti">
          <p className="text-xs text-muted-foreground">Router je vždy aktivní a vybírá z povolených specialistů.</p>
          {SPECIALISTS.map((id) => (
            <Toggle
              key={id}
              label={AGENTS[id].name}
              hint={AGENTS[id].role}
              color={AGENTS[id].color}
              checked={settings.enabledAgents.includes(id)}
              onChange={(v) =>
                patch({ enabledAgents: v ? [...settings.enabledAgents, id] : settings.enabledAgents.filter((a) => a !== id) })
              }
            />
          ))}
        </Section>

        <Section title="Rozpočet a spotřeba">
          <NumberField
            label="Max. cena jednoho požadavku (USD)"
            value={settings.maxCostUsd}
            step={0.005}
            min={0.001}
            max={status?.limits.maxRequestUsd ?? 5}
            onChange={(v) => patch({ maxCostUsd: v })}
          />
          <NumberField
            label="Max. tokenů na požadavek"
            value={settings.maxTokens}
            step={1000}
            min={2000}
            max={status?.limits.maxRequestTokens ?? 500000}
            onChange={(v) => patch({ maxTokens: Math.round(v) })}
          />
          {status && (
            <p className="text-xs text-muted-foreground">
              Serverové limity: {formatUsd(status.limits.maxRequestUsd)} a {status.limits.maxRequestTokens.toLocaleString("cs-CZ")} tokenů
              na požadavek, {formatUsd(status.limits.dailyBudgetUsd)} denně, {status.limits.runsPer10Min} běhů / 10 min.
            </p>
          )}
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <Stat label="Dnes na serveru" value={status?.usageToday ? formatUsd(status.usageToday.costUsd) : "–"} sub={status?.usageToday ? `${status.usageToday.requests} běhů${status.usageToday.shared ? "" : " · tato instance"}` : "po přihlášení"} />
            <Stat label="Celkem v zařízení" value={formatUsd(lifetime.costUsd)} sub={`${lifetime.runs} běhů · ${(lifetime.promptTokens + lifetime.completionTokens).toLocaleString("cs-CZ")} tok.`} />
          </dl>
          <p className="text-xs text-muted-foreground">
            Cena je odhad z počtu tokenů vrácených DeepSeek a ceníku (špička/mimo špičku). Přesné vyúčtování najdete v konzoli DeepSeek.
          </p>
          <button type="button" onClick={props.onResetLifetime} className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <RotateCcw className="size-4" aria-hidden="true" /> Vynulovat statistiku zařízení
          </button>
        </Section>

        <Section title="Hlas a paměť">
          <Toggle
            label="Automaticky předčítat odpovědi"
            hint={props.voiceSupport.synthesis ? "Česká syntéza řeči prohlížeče." : "Syntéza řeči není podporována."}
            checked={settings.speakAnswers}
            disabled={!props.voiceSupport.synthesis}
            onChange={(v) => patch({ speakAnswers: v })}
          />
          <p className="text-xs text-muted-foreground">
            Rozpoznávání řeči: {props.voiceSupport.recognition ? "podporováno (cs-CZ)" : "nepodporováno – použijte diktování na klávesnici iPhonu"}. JARVIS
            poslouchá jen po stisknutí mikrofonu, nikdy na pozadí.
          </p>
          <Toggle label="Ukládat historii konverzací" hint="Shrnutí posledních 30 běhů v tomto zařízení." checked={settings.autoHistory} onChange={(v) => patch({ autoHistory: v })} />
          <Toggle
            label="Posílat citlivé položky jako kontext"
            hint="Citlivé položky se pak odesílají do DeepSeek."
            checked={settings.useSensitiveInContext}
            onChange={(v) => patch({ useSensitiveInContext: v })}
          />
        </Section>

        <p className="pb-4 text-center font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground/60">
          VOBIO JARVIS · Jan Vobora
        </p>
      </div>
    </SlideOver>
  )
}

function AuthBox({ authenticated, onChange }: { authenticated: boolean; onChange: () => void }) {
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (authenticated) {
    return (
      <button
        type="button"
        onClick={async () => {
          await fetch("/api/auth", { method: "DELETE" })
          onChange()
        }}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-secondary text-sm"
      >
        <LogOut className="size-4" aria-hidden="true" /> Odhlásit se
      </button>
    )
  }

  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
          const res = await fetch("/api/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) setError(data.error ?? "Přihlášení selhalo.")
          else {
            setCode("")
            onChange()
          }
        } catch {
          setError("Server není dostupný.")
        } finally {
          setBusy(false)
        }
      }}
    >
      <label htmlFor="access-code" className="text-sm text-muted-foreground">
        Přístupový kód
      </label>
      <div className="flex gap-2">
        <input
          id="access-code"
          type="password"
          autoComplete="current-password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="min-h-11 flex-1 rounded-xl border border-input bg-background px-3 text-base"
        />
        <button type="submit" disabled={busy || !code} className="flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-40">
          <LogIn className="size-4" aria-hidden="true" /> {busy ? "…" : "Přihlásit"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">{title}</h3>
      {children}
    </section>
  )
}

function StatusRow({ ok, label, detail, optional }: { ok: boolean; label: string; detail: string; optional?: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-secondary/50 px-3 py-2.5">
      {ok ? (
        <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden="true" />
      ) : (
        <CircleSlash className={cn("size-5 shrink-0", optional ? "text-muted-foreground" : "text-warning")} aria-hidden="true" />
      )}
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </div>
      <span className="sr-only">{ok ? "v pořádku" : "nenastaveno"}</span>
    </div>
  )
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
  color,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  color?: string
}) {
  return (
    <label className={cn("flex min-h-11 cursor-pointer items-center gap-3", disabled && "cursor-not-allowed opacity-50")}>
      {color && <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />}
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-foreground">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden="true"
        className={cn(
          "relative h-7 w-12 shrink-0 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
          checked ? "bg-primary" : "bg-secondary",
        )}
      >
        <span className={cn("absolute top-1 size-5 rounded-full bg-white transition-all", checked ? "left-6" : "left-1")} />
      </span>
    </label>
  )
}

function Choice({ selected, onClick, label, sub }: { selected: boolean; onClick: () => void; label: string; sub?: string }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "min-h-11 rounded-xl border px-3 py-2 text-left text-sm transition-colors",
        selected ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground",
      )}
    >
      <span className="block font-medium">{label}</span>
      {sub && <span className="block text-xs opacity-80">{sub}</span>}
    </button>
  )
}

function NumberField({
  label,
  value,
  onChange,
  step,
  min,
  max,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step: number
  min: number
  max: number
}) {
  return (
    <label className="block text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)))
        }}
        className="mt-1 min-h-11 w-full rounded-xl border border-input bg-background px-3 font-mono text-base"
      />
    </label>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl bg-secondary/50 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-base text-foreground">{value}</dd>
      <dd className="text-[11px] text-muted-foreground">{sub}</dd>
    </div>
  )
}
