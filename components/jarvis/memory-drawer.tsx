"use client"

import { Cloud, Download, HardDrive, Lock, Pencil, Plus, Trash2, Upload } from "lucide-react"
import { useRef, useState } from "react"
import { SlideOver } from "./slide-over"
import { CATEGORY_LABELS, type StoredMemory, type useMemories } from "@/hooks/use-memories"
import type { MemoryCategory } from "@/lib/jarvis/types"
import { cn } from "@/lib/utils"

type MemoryApi = ReturnType<typeof useMemories>

interface MemoryDrawerProps {
  open: boolean
  onClose: () => void
  memory: MemoryApi
  cloudAvailable: boolean
  cloudReason: string
}

interface Draft {
  id?: string
  category: MemoryCategory
  title: string
  content: string
  sensitive: boolean
  location: "local" | "cloud"
}

const CATEGORIES = Object.keys(CATEGORY_LABELS) as MemoryCategory[]

export function MemoryDrawer({ open, onClose, memory, cloudAvailable, cloudReason }: MemoryDrawerProps) {
  const [filter, setFilter] = useState<MemoryCategory | "all">("all")
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const visible = memory.items.filter((m) => filter === "all" || m.category === filter)

  const startNew = () =>
    setDraft({
      category: filter === "all" ? "preferences" : filter,
      title: "",
      content: "",
      sensitive: false,
      location: "local",
    })

  const edit = (m: StoredMemory) =>
    setDraft({ id: m.id, category: m.category, title: m.title, content: m.content, sensitive: m.sensitive, location: m.location })

  const submit = async () => {
    if (!draft || !draft.title.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      await memory.save({ ...draft, location: draft.sensitive ? "cloud" : draft.location })
      setDraft(null)
      setMessage({ tone: "ok", text: "Uloženo." })
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "Uložení selhalo." })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (m: StoredMemory) => {
    if (!window.confirm(`Opravdu smazat „${m.title}“?`)) return
    try {
      await memory.remove(m)
      setMessage({ tone: "ok", text: "Smazáno." })
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "Smazání selhalo." })
    }
  }

  const onImport = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    try {
      const r = await memory.importJson(file)
      setMessage({
        tone: "ok",
        text: `Importováno ${r.imported} položek${r.skipped ? `, přeskočeno ${r.skipped} (neplatné nebo citlivé bez cloudu)` : ""}.`,
      })
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "Import selhal – neplatný JSON." })
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      title="Paměť"
      description="Kontext, který JARVIS vybírá pro každý úkol. Model se tím nepřetrénovává."
    >
      <div className="space-y-4">
        <div
          className={cn(
            "flex items-start gap-2 rounded-2xl p-3 text-xs",
            cloudAvailable ? "bg-success/10 text-success" : "bg-secondary text-muted-foreground",
          )}
        >
          {cloudAvailable ? <Cloud className="size-4 shrink-0" aria-hidden="true" /> : <HardDrive className="size-4 shrink-0" aria-hidden="true" />}
          <span>{cloudAvailable ? "Synchronizace přes databázi je aktivní. Citlivé položky se ukládají šifrovaně." : cloudReason}</span>
        </div>
        {memory.cloudError && (
          <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-xs text-destructive">
            {memory.cloudError.message}
          </p>
        )}

        <div className="flex gap-2">
          <button type="button" onClick={startNew} className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground">
            <Plus className="size-4" aria-hidden="true" /> Nová položka
          </button>
          <button
            type="button"
            onClick={memory.exportJson}
            aria-label="Exportovat paměť do JSON"
            className="flex size-11 items-center justify-center rounded-2xl bg-secondary text-muted-foreground hover:text-foreground"
          >
            <Download className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            aria-label="Importovat paměť z JSON"
            className="flex size-11 items-center justify-center rounded-2xl bg-secondary text-muted-foreground hover:text-foreground"
          >
            <Upload className="size-4" aria-hidden="true" />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => onImport(e.target.files?.[0])}
          />
        </div>

        {message && (
          <p role="status" className={cn("text-sm", message.tone === "ok" ? "text-success" : "text-destructive")}>
            {message.text}
          </p>
        )}

        {draft && (
          <form
            className="space-y-3 rounded-2xl border border-primary/30 bg-secondary/50 p-4"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <label className="block text-sm">
              <span className="text-muted-foreground">Kategorie</span>
              <select
                value={draft.category}
                onChange={(e) => setDraft({ ...draft, category: e.target.value as MemoryCategory })}
                className="mt-1 min-h-11 w-full rounded-xl border border-input bg-background px-3 text-base"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-muted-foreground">Název</span>
              <input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                maxLength={200}
                required
                className="mt-1 min-h-11 w-full rounded-xl border border-input bg-background px-3 text-base"
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted-foreground">Obsah</span>
              <textarea
                value={draft.content}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                maxLength={4000}
                rows={4}
                className="mt-1 w-full rounded-xl border border-input bg-background px-3 py-2 text-base"
              />
            </label>
            <fieldset className="space-y-2 text-sm">
              <legend className="text-muted-foreground">Úložiště</legend>
              <div className="grid grid-cols-2 gap-2">
                {(["local", "cloud"] as const).map((loc) => (
                  <label
                    key={loc}
                    className={cn(
                      "flex min-h-11 items-center justify-center gap-2 rounded-xl border px-2",
                      draft.location === loc || (loc === "cloud" && draft.sensitive) ? "border-primary text-primary" : "border-input text-muted-foreground",
                      loc === "cloud" && !cloudAvailable && "opacity-40",
                    )}
                  >
                    <input
                      type="radio"
                      name="location"
                      className="sr-only"
                      checked={draft.location === loc}
                      disabled={(loc === "cloud" && !cloudAvailable) || (loc === "local" && draft.sensitive)}
                      onChange={() => setDraft({ ...draft, location: loc })}
                    />
                    {loc === "local" ? "Toto zařízení" : "Cloud (DB)"}
                  </label>
                ))}
              </div>
              <label className={cn("flex min-h-11 items-center gap-3", !cloudAvailable && "opacity-40")}>
                <input
                  type="checkbox"
                  checked={draft.sensitive}
                  disabled={!cloudAvailable}
                  onChange={(e) => setDraft({ ...draft, sensitive: e.target.checked, location: e.target.checked ? "cloud" : draft.location })}
                  className="size-5 accent-[#22d3ee]"
                />
                <span>
                  Citlivá položka{" "}
                  <span className="text-xs text-muted-foreground">(jen šifrovaně v DB po přihlášení)</span>
                </span>
              </label>
            </fieldset>
            <div className="flex gap-2">
              <button type="submit" disabled={busy || !draft.title.trim()} className="min-h-11 flex-1 rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-40">
                {busy ? "Ukládám…" : "Uložit"}
              </button>
              <button type="button" onClick={() => setDraft(null)} className="min-h-11 rounded-xl bg-secondary px-4 text-sm">
                Zrušit
              </button>
            </div>
          </form>
        )}

        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Filtr kategorií">
          {(["all", ...CATEGORIES] as const).map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={filter === c}
              onClick={() => setFilter(c)}
              className={cn(
                "min-h-11 shrink-0 rounded-full px-3 text-xs font-medium",
                filter === c ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground",
              )}
            >
              {c === "all" ? `Vše (${memory.items.length})` : CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>

        {visible.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            Zatím žádné položky. Přidejte preference, projekty nebo úkoly – JARVIS je použije jako kontext.
          </p>
        ) : (
          <ul className="space-y-2">
            {visible.map((m) => (
              <li key={`${m.location}-${m.id}`} className="rounded-2xl bg-secondary/50 p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                      {m.location === "cloud" ? <Cloud className="size-3" aria-label="Cloud" /> : <HardDrive className="size-3" aria-label="Místně" />}
                      {m.sensitive && <Lock className="size-3 text-warning" aria-label="Citlivé" />}
                      {CATEGORY_LABELS[m.category]}
                    </p>
                    <p className="mt-0.5 truncate font-medium text-foreground">{m.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{m.content}</p>
                  </div>
                  <button type="button" onClick={() => edit(m)} aria-label={`Upravit ${m.title}`} className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:text-foreground">
                    <Pencil className="size-4" aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => remove(m)} aria-label={`Smazat ${m.title}`} className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:text-destructive">
                    <Trash2 className="size-4" aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SlideOver>
  )
}
