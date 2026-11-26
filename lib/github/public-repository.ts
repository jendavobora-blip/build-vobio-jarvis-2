import { z } from "zod"

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/

const repositorySchema = z.object({
  full_name: z.string().min(1).max(200),
  description: z.string().nullable(),
  html_url: z.string().url(),
  default_branch: z.string().min(1).max(100),
  private: z.boolean(),
  stargazers_count: z.number().int().nonnegative(),
  open_issues_count: z.number().int().nonnegative(),
  updated_at: z.string().min(1).max(64),
})

const commitsSchema = z.array(
  z.object({
    sha: z.string().regex(/^[a-f0-9]{7,40}$/i),
    html_url: z.string().url(),
    commit: z.object({
      message: z.string().min(1).max(20_000),
      author: z.object({
        name: z.string().max(200).nullable().optional(),
        date: z.string().max(64).nullable().optional(),
      }).nullable().optional(),
    }),
    author: z.object({ login: z.string().max(39) }).nullable().optional(),
  }),
)

export interface PublicGitHubRepository {
  fullName: string
  description: string | null
  url: string
  defaultBranch: string
  stars: number
  openIssues: number
  updatedAt: string
  commits: { sha: string; url: string; message: string; author: string; date: string | null }[]
}

export class GitHubRepositoryError extends Error {
  constructor(
    readonly status: 400 | 404 | 429 | 502,
    message: string,
  ) {
    super(message)
    this.name = "GitHubRepositoryError"
  }
}

export function isValidRepositoryPath(owner: string, repository: string): boolean {
  return OWNER_PATTERN.test(owner) && REPOSITORY_PATTERN.test(repository)
}

async function requestGitHubJson(
  path: string,
  fetcher: typeof fetch,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetcher(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(8_000),
      next: { revalidate: 60 },
    })
  } catch {
    throw new GitHubRepositoryError(502, "GitHub API není dostupné.")
  }

  if (!response.ok) {
    if (response.status === 404) throw new GitHubRepositoryError(404, "Veřejný repozitář nebyl nalezen.")
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
      throw new GitHubRepositoryError(429, "GitHub dočasně omezil počet požadavků.")
    }
    throw new GitHubRepositoryError(502, "GitHub API vrátilo chybu.")
  }

  try {
    return await response.json()
  } catch {
    throw new GitHubRepositoryError(502, "GitHub API vrátilo nečitelnou odpověď.")
  }
}

function isGitHubUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.hostname === "github.com"
  } catch {
    return false
  }
}

export async function getPublicGitHubRepository(
  owner: string,
  repository: string,
  fetcher: typeof fetch = fetch,
): Promise<PublicGitHubRepository> {
  if (!isValidRepositoryPath(owner, repository)) {
    throw new GitHubRepositoryError(400, "Zadejte platného vlastníka a název repozitáře GitHub.")
  }

  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
  const repositoryPayload = repositorySchema.safeParse(await requestGitHubJson(path, fetcher))
  if (!repositoryPayload.success || repositoryPayload.data.private || !isGitHubUrl(repositoryPayload.data.html_url)) {
    if (repositoryPayload.success && repositoryPayload.data.private) {
      throw new GitHubRepositoryError(404, "Veřejný repozitář nebyl nalezen.")
    }
    throw new GitHubRepositoryError(502, "GitHub API vrátilo neplatné údaje o repozitáři.")
  }

  const commitsPayload = commitsSchema.safeParse(
    await requestGitHubJson(`${path}/commits?per_page=5`, fetcher),
  )
  if (!commitsPayload.success || commitsPayload.data.some((commit) => !isGitHubUrl(commit.html_url))) {
    throw new GitHubRepositoryError(502, "GitHub API vrátilo neplatné údaje o commitech.")
  }

  const data = repositoryPayload.data
  return {
    fullName: data.full_name,
    description: data.description,
    url: data.html_url,
    defaultBranch: data.default_branch,
    stars: data.stargazers_count,
    openIssues: data.open_issues_count,
    updatedAt: data.updated_at,
    commits: commitsPayload.data.map((commit) => ({
      sha: commit.sha,
      url: commit.html_url,
      message: commit.commit.message.split("\n", 1)[0]?.slice(0, 240) ?? "",
      author: commit.author?.login ?? commit.commit.author?.name ?? "Neznámý autor",
      date: commit.commit.author?.date ?? null,
    })),
  }
}
