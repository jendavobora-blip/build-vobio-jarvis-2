"use client"

import { useCallback, useSyncExternalStore } from "react"

const listeners = new Map<string, Set<() => void>>()
const cache = new Map<string, { raw: string | null; value: unknown }>()

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(key)
  } catch {
    return fallback
  }
  const hit = cache.get(key)
  if (hit && hit.raw === raw) return hit.value as T
  let value: T = fallback
  if (raw) {
    try {
      value = { ...(fallback as object), ...JSON.parse(raw) } as T
      if (Array.isArray(fallback)) value = JSON.parse(raw) as T
    } catch {
      value = fallback
    }
  }
  cache.set(key, { raw, value })
  return value
}

function notify(key: string) {
  listeners.get(key)?.forEach((l) => l())
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => e.key && notify(e.key))
}

/** localStorage-backed state that is hydration safe (server renders the fallback). */
export function useLocalState<T>(key: string, fallback: T): [T, (next: T | ((prev: T) => T)) => void] {
  const subscribe = useCallback(
    (cb: () => void) => {
      const set = listeners.get(key) ?? new Set()
      set.add(cb)
      listeners.set(key, set)
      return () => set.delete(cb)
    },
    [key],
  )
  const value = useSyncExternalStore(
    subscribe,
    () => read(key, fallback),
    () => fallback,
  )
  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = read(key, fallback)
      const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next
      try {
        window.localStorage.setItem(key, JSON.stringify(resolved))
      } catch {
        // Storage full or blocked (private mode): keep working in memory for this session.
        cache.set(key, { raw: JSON.stringify(resolved), value: resolved })
      }
      notify(key)
    },
    // fallback is a stable module-level constant at every call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  )
  return [value, setValue]
}
