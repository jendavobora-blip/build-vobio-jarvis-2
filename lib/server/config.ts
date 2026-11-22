import "server-only"
import { isLiveAccessEnabled } from "@/lib/jarvis/live-access"
import { stableOwnerId } from "./owner-id"

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  const parsed = raw ? Number(raw) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

export const serverConfig = {
  get deepseekKey(): string | undefined {
    const key = process.env.DEEPSEEK_API_KEY?.trim()
    return key ? key : undefined
  },
  get accessCode(): string | undefined {
    const code = process.env.JARVIS_ACCESS_CODE?.trim()
    return code && code.length >= 8 ? code : undefined
  },
  get ownerId(): string | undefined {
    return stableOwnerId(process.env.JARVIS_OWNER_ID)
  },
  get sessionSecret(): string | undefined {
    const secret = process.env.JARVIS_SESSION_SECRET
    return secret && Buffer.byteLength(secret, "utf8") >= 32 ? secret : undefined
  },
  get encryptionSecret(): string | undefined {
    const secret = process.env.JARVIS_ENCRYPTION_KEY
    return secret && Buffer.byteLength(secret, "utf8") >= 32 ? secret : undefined
  },
  get databaseUrl(): string | undefined {
    return process.env.DATABASE_URL?.trim() || undefined
  },
  get liveEnabled(): boolean {
    return isLiveAccessEnabled(process.env.JARVIS_LIVE_ENABLED, process.env.VERCEL_ENV)
  },
  limits: {
    get maxRequestUsd() {
      return numberEnv("JARVIS_MAX_REQUEST_USD", 0.05, 0.001, 5)
    },
    get maxRequestTokens() {
      return numberEnv("JARVIS_MAX_REQUEST_TOKENS", 60_000, 2_000, 500_000)
    },
    get dailyBudgetUsd() {
      return numberEnv("JARVIS_DAILY_BUDGET_USD", 1, 0.01, 100)
    },
    get runsPerWindow() {
      return numberEnv("JARVIS_RUNS_PER_10_MIN", 12, 1, 200)
    },
  },
}

export function isLiveAvailable(): boolean {
  return Boolean(
    serverConfig.liveEnabled &&
      serverConfig.deepseekKey &&
      serverConfig.accessCode &&
      serverConfig.ownerId &&
      serverConfig.sessionSecret &&
      serverConfig.encryptionSecret,
  )
}
