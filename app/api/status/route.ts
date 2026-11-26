import { createHmac } from "node:crypto"
import { authenticatedUser } from "@/lib/server/auth"
import { serverConfig } from "@/lib/server/config"
import { getDailyUsage, isDatabaseConfigured } from "@/lib/server/db"
import type { StatusResponse } from "@/lib/jarvis/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const user = await authenticatedUser()
  const authenticated = Boolean(user)
  const body: StatusResponse = {
    deepseekConfigured: Boolean(serverConfig.deepseekKey),
    liveEnabled: serverConfig.liveEnabled,
    authConfigured: Boolean(serverConfig.accessCode && serverConfig.ownerId && serverConfig.sessionSecret && serverConfig.encryptionSecret),
    authenticated,
    accountScope: user && serverConfig.sessionSecret
      ? createHmac("sha256", serverConfig.sessionSecret).update(`status-scope:${user.ownerId}:${user.id}`).digest("base64url")
      : undefined,
    userRole: user?.role,
    databaseConfigured: isDatabaseConfigured(),
    limits: {
      maxRequestUsd: serverConfig.limits.maxRequestUsd,
      maxRequestTokens: serverConfig.limits.maxRequestTokens,
      dailyBudgetUsd: serverConfig.limits.dailyBudgetUsd,
      runsPer10Min: serverConfig.limits.runsPerWindow,
    },
    usageToday: user?.role === "owner" ? await getDailyUsage() : null,
  }
  return Response.json(body, { headers: { "Cache-Control": "no-store" } })
}
