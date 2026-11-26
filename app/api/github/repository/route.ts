import { getPublicGitHubRepository, GitHubRepositoryError, isValidRepositoryPath } from "@/lib/github/public-repository"
import { cachedGitHubRepository, singleFlightGitHubRepository, storeCachedGitHubRepository } from "@/lib/github/request-cache"
import { rateLimitResponse } from "@/lib/server/request-security"
import { rateLimit } from "@/lib/server/rate-limit"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const clientLimit = await rateLimitResponse(request, "github-public-client", 20, 60_000)
  if (clientLimit) return clientLimit

  const url = new URL(request.url)
  const owner = url.searchParams.get("owner")?.trim() ?? ""
  const repository = url.searchParams.get("repo")?.trim() ?? ""
  if (!isValidRepositoryPath(owner, repository)) {
    return Response.json(
      { error: "Zadejte platného vlastníka a název repozitáře GitHub." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    )
  }

  try {
    const key = `${owner.toLowerCase()}/${repository.toLowerCase()}`
    const cached = cachedGitHubRepository(key)
    if (cached) {
      return Response.json(
        { repository: cached },
        { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } },
      )
    }
    const result = await singleFlightGitHubRepository(key, async () => {
      const cachedAgain = cachedGitHubRepository(key)
      if (cachedAgain) return cachedAgain
      const fetched = await getPublicGitHubRepository(owner, repository, fetch, async () => {
        let quota
        try {
          quota = await rateLimit("github-public-shared-quota", 20, 60 * 60_000)
        } catch {
          throw new GitHubRepositoryError(503, "Sdílená ochrana GitHub API není dostupná.")
        }
        if (!quota.ok) throw new GitHubRepositoryError(429, "Sdílený limit GitHub API byl vyčerpán.")
      })
      storeCachedGitHubRepository(key, fetched)
      return fetched
    })
    return Response.json(
      { repository: result },
      { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } },
    )
  } catch (error) {
    if (error instanceof GitHubRepositoryError) {
      return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } })
    }
    return Response.json(
      { error: "GitHub repozitář nelze načíst." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    )
  }
}
