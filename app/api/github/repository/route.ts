import { getPublicGitHubRepository, GitHubRepositoryError } from "@/lib/github/public-repository"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const owner = url.searchParams.get("owner")?.trim() ?? ""
  const repository = url.searchParams.get("repo")?.trim() ?? ""

  try {
    const result = await getPublicGitHubRepository(owner, repository)
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
