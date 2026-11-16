"use client"

import useSWR from "swr"
import { useCallback, useMemo } from "react"
import { useLocalState } from "@/lib/jarvis/local-store"
import type { MemoryCategory, MemoryItem } from "@/lib/jarvis/types"

export type StoredMemory = MemoryItem & { location: "local" | "cloud" }

const EMPTY: MemoryItem[] = []
const CATEGORIES: MemoryCategory[] = ["preferences", "projects", "business", "investments", "tasks", "history"]

export const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preferences: "Osobní preference",
  projects: "Znalosti o projektech",
  business: "Byznys plány",
  investments: "Investiční výzkum",
  tasks: "Aktivní úkoly",
  history: "Historie konverzací",
}

async function cloudFetcher(url: string): Promise<MemoryItem[]> {
  const res = await fetch(url, { cache: "no-store" })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? "Načtení paměti selhalo.")
  return data.items as MemoryItem[]
}

function newId() {
  return crypto.randomUUID()
}

export function useMemories(cloudEnabled: boolean) {
  const [local, setLocal] = useLocalState<MemoryItem[]>("vobio-jarvis.memory.v1", EMPTY)
  const cloud = useSWR(cloudEnabled ? "/api/memory" : null, cloudFetcher)

  const items: StoredMemory[] = useMemo(
    () =>
      [
        ...local.map((m) => ({ ...m, location: "local" as const })),
        ...(cloudEnabled ? (cloud.data ?? []) : []).map((m) => ({ ...m, location: "cloud" as const })),
      ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [local, cloud.data, cloudEnabled],
  )

  const save = useCallback(
    async (input: Omit<MemoryItem, "id" | "createdAt" | "updatedAt"> & { id?: string; location: "local" | "cloud" }) => {
      const timestamp = new Date().toISOString()
      const existing = items.find((i) => i.id === input.id)
      const item: MemoryItem = {
        id: input.id ?? newId(),
        category: input.category,
        title: input.title.trim().slice(0, 200),
        content: input.content.slice(0, 4000),
        sensitive: input.location === "cloud" ? input.sensitive : false,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }
      if (input.location === "cloud") {
        const res = await fetch("/api/memory", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item),
        })
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Uložení selhalo.")
        if (existing?.location === "local") setLocal((prev) => prev.filter((m) => m.id !== item.id))
        await cloud.mutate()
      } else {
        if (existing?.location === "cloud") await remove(existing)
        setLocal((prev) => [item, ...prev.filter((m) => m.id !== item.id)])
      }
    },
    // remove is defined below and stable for the same inputs
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, setLocal, cloud],
  )

  const remove = useCallback(
    async (item: StoredMemory) => {
      if (item.location === "cloud") {
        const res = await fetch(`/api/memory?id=${encodeURIComponent(item.id)}`, { method: "DELETE" })
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Smazání selhalo.")
        await cloud.mutate()
      } else {
        setLocal((prev) => prev.filter((m) => m.id !== item.id))
      }
    },
    [setLocal, cloud],
  )

  const addHistory = useCallback(
    (prompt: string, answer: string) => {
      const timestamp = new Date().toISOString()
      const entry: MemoryItem = {
        id: newId(),
        category: "history",
        title: prompt.slice(0, 120),
        content: answer.replace(/[#*`]/g, "").slice(0, 1200),
        sensitive: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      setLocal((prev) => {
        const history = prev.filter((m) => m.category === "history")
        const rest = prev.filter((m) => m.category !== "history")
        return [entry, ...history.slice(0, 29), ...rest]
      })
    },
    [setLocal],
  )

  const exportJson = useCallback(() => {
    const payload = {
      app: "VOBIO JARVIS",
      version: 1,
      exportedAt: new Date().toISOString(),
      items: items.map(({ location, ...rest }) => ({ ...rest, location })),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `vobio-jarvis-pamet-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }, [items])

  const importJson = useCallback(
    async (file: File): Promise<{ imported: number; skipped: number }> => {
      const text = await file.text()
      const parsed = JSON.parse(text) as { items?: unknown }
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : null
      if (!list) throw new Error("Soubor neobsahuje seznam položek paměti.")
      let imported = 0
      let skipped = 0
      const toLocal: MemoryItem[] = []
      for (const raw of list.slice(0, 500)) {
        const r = raw as Partial<MemoryItem> & { location?: string }
        if (typeof r.title !== "string" || typeof r.content !== "string" || !CATEGORIES.includes(r.category as MemoryCategory)) {
          skipped++
          continue
        }
        const base = {
          id: typeof r.id === "string" && r.id.length <= 64 ? r.id : newId(),
          category: r.category as MemoryCategory,
          title: r.title.slice(0, 200) || "Bez názvu",
          content: r.content.slice(0, 4000),
          createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        if (r.sensitive) {
          if (!cloudEnabled) {
            skipped++
            continue
          }
          const res = await fetch("/api/memory", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...base, sensitive: true }),
          })
          if (res.ok) imported++
          else skipped++
          continue
        }
        toLocal.push({ ...base, sensitive: false })
        imported++
      }
      if (toLocal.length) {
        setLocal((prev) => {
          const ids = new Set(toLocal.map((m) => m.id))
          return [...toLocal, ...prev.filter((m) => !ids.has(m.id))]
        })
      }
      if (cloudEnabled) await cloud.mutate()
      return { imported, skipped }
    },
    [cloudEnabled, setLocal, cloud],
  )

  return {
    items,
    cloudError: cloud.error as Error | undefined,
    cloudLoading: cloud.isLoading,
    save,
    remove,
    addHistory,
    exportJson,
    importJson,
  }
}
