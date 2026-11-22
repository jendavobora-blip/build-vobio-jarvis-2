import "server-only"
import { clientIp, rateLimit } from "./rate-limit"

export function hasValidRequestOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  if (!origin || request.headers.get("sec-fetch-site") === "cross-site") return false
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

export async function rateLimitResponse(
  request: Request,
  scope: string,
  limit: number,
  windowMs: number,
): Promise<Response | null> {
  try {
    const result = await rateLimit(`${scope}:${clientIp(request.headers)}`, limit, windowMs)
    if (result.ok) return null
    return Response.json(
      { error: "Příliš mnoho požadavků. Zkuste to později." },
      { status: 429, headers: { "Retry-After": String(result.retryAfterSec) } },
    )
  } catch {
    return Response.json({ error: "Sdílená ochrana požadavků není dostupná." }, { status: 503 })
  }
}
