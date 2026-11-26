import "server-only"
import { createHash } from "node:crypto"
import { consumeSharedRateLimit, isDatabaseConfigured } from "./db"

const buckets = new Map<string, number[]>()

export async function rateLimit(key: string, limit: number, windowMs: number): Promise<{ ok: boolean; retryAfterSec: number }> {
  if (isDatabaseConfigured() || process.env.NODE_ENV === "production") {
    const digest = createHash("sha256").update(key).digest("base64url")
    return consumeSharedRateLimit(digest, limit, windowMs)
  }
  return localRateLimit(key, limit, windowMs)
}

function localRateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now()
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs)
  if (hits.length >= limit) {
    buckets.set(key, hits)
    return { ok: false, retryAfterSec: Math.ceil((windowMs - (now - hits[0])) / 1000) }
  }
  hits.push(now)
  buckets.set(key, hits)
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.every((t) => now - t >= windowMs)) buckets.delete(k)
  }
  return { ok: true, retryAfterSec: 0 }
}

export function clientIp(headers: Headers): string {
  const trusted = headers.get("x-real-ip")?.trim()
  return trusted && /^[\da-f:.]+$/i.test(trusted) ? trusted : "unknown"
}
