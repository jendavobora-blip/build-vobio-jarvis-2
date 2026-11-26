import type { PublicGitHubRepository } from "./public-repository"

interface CacheEntry {
  expiresAt: number
  value: PublicGitHubRepository
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<PublicGitHubRepository>>()

export function cachedGitHubRepository(key: string): PublicGitHubRepository | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return undefined
  }
  return entry.value
}

export function storeCachedGitHubRepository(key: string, value: PublicGitHubRepository, ttlMs = 60_000): void {
  cache.set(key, { expiresAt: Date.now() + ttlMs, value })
  if (cache.size > 500) {
    for (const [cacheKey, entry] of cache) {
      if (entry.expiresAt <= Date.now()) cache.delete(cacheKey)
    }
    while (cache.size > 500) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }
}

export function singleFlightGitHubRepository(
  key: string,
  loader: () => Promise<PublicGitHubRepository>,
): Promise<PublicGitHubRepository> {
  const active = inflight.get(key)
  if (active) return active
  const request = loader().finally(() => inflight.delete(key))
  inflight.set(key, request)
  return request
}
