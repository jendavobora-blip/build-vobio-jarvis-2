import assert from "node:assert/strict"
import test from "node:test"
import {
  getPublicGitHubRepository,
  GitHubRepositoryError,
  isValidRepositoryPath,
} from "../lib/github/public-repository"
import { singleFlightGitHubRepository } from "../lib/github/request-cache"

const publicRepository = {
  full_name: "octocat/hello-world",
  description: "A sample repository",
  html_url: "https://github.com/octocat/hello-world",
  default_branch: "main",
  private: false,
  stargazers_count: 7,
  open_issues_count: 2,
  updated_at: "2026-11-26T10:00:00Z",
}

const publicCommit = {
  sha: "1234567890abcdef1234567890abcdef12345678",
  html_url: "https://github.com/octocat/hello-world/commit/1234567890abcdef1234567890abcdef12345678",
  commit: {
    message: "Add example\n\nLong body",
    author: { name: "Octocat", date: "2026-11-26T09:00:00Z" },
  },
  author: { login: "octocat" },
}

test("GitHub repository lookup returns only public metadata and recent commits", async () => {
  const requests: { url: string; init?: RequestInit }[] = []
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    return Response.json(requests.length === 1 ? publicRepository : [publicCommit])
  }

  const repository = await getPublicGitHubRepository("octocat", "hello-world", fetcher)

  assert.equal(repository.fullName, "octocat/hello-world")
  assert.equal(repository.url, "https://github.com/octocat/hello-world")
  assert.equal(repository.commits[0]?.message, "Add example")
  assert.equal(repository.commits[0]?.author, "octocat")
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://api.github.com/repos/octocat/hello-world",
      "https://api.github.com/repos/octocat/hello-world/commits?per_page=5",
    ],
  )
  assert.ok(requests.every((request) => (request.init?.headers as Record<string, string>)["X-GitHub-Api-Version"] === "2022-11-28"))
})

test("GitHub repository lookup validates path segments before making requests", async () => {
  assert.equal(isValidRepositoryPath("octocat", "hello-world"), true)
  assert.equal(isValidRepositoryPath("octocat", "hello_world.js"), true)
  assert.equal(isValidRepositoryPath("octocat", "hello-world-v2"), true)
  assert.equal(isValidRepositoryPath("octocat", ".github"), true)
  assert.equal(isValidRepositoryPath("../attacker", "repo"), false)
  assert.equal(isValidRepositoryPath("octocat", ".."), false)
  assert.equal(isValidRepositoryPath("octocat", "repo/name"), false)

  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls += 1
    return Response.json(publicRepository)
  }

  await assert.rejects(getPublicGitHubRepository("../attacker", "repo", fetcher), (error: unknown) => {
    assert.ok(error instanceof GitHubRepositoryError)
    assert.equal(error.status, 400)
    return true
  })
  assert.equal(calls, 0)
})

test("private repositories are not disclosed by the public GitHub integration", async () => {
  const fetcher: typeof fetch = async () => Response.json({ ...publicRepository, private: true })

  await assert.rejects(getPublicGitHubRepository("octocat", "hello-world", fetcher), (error: unknown) => {
    assert.ok(error instanceof GitHubRepositoryError)
    assert.equal(error.status, 404)
    return true
  })
})

test("GitHub rate limits are surfaced as a retryable public error", async () => {
  const fetcher: typeof fetch = async () => new Response(null, {
    status: 403,
    headers: { "x-ratelimit-remaining": "0" },
  })

  await assert.rejects(getPublicGitHubRepository("octocat", "hello-world", fetcher), (error: unknown) => {
    assert.ok(error instanceof GitHubRepositoryError)
    assert.equal(error.status, 429)
    return true
  })
})

  test("empty public repositories are valid and expose no commits", async () => {
    let requests = 0
    const fetcher: typeof fetch = async () => {
      requests += 1
      if (requests === 1) return Response.json({ ...publicRepository, full_name: "octocat/empty" })
      return Response.json({ message: "Git Repository is empty." }, { status: 409 })
    }
    const repository = await getPublicGitHubRepository("octocat", "empty", fetcher)
    assert.equal(repository.fullName, "octocat/empty")
    assert.deepEqual(repository.commits, [])
  })

  test("concurrent GitHub lookups are coalesced for one repository", async () => {
    let calls = 0
    const loader = async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return {
        fullName: "octocat/hello-world",
        description: null,
        url: "https://github.com/octocat/hello-world",
        defaultBranch: "main",
        stars: 0,
        openIssues: 0,
        updatedAt: "2026-11-26T10:00:00Z",
        commits: [],
      }
    }

    const [first, second] = await Promise.all([
      singleFlightGitHubRepository("octocat/hello-world", loader),
      singleFlightGitHubRepository("octocat/hello-world", loader),
    ])
    assert.equal(first.fullName, "octocat/hello-world")
    assert.equal(second.fullName, first.fullName)
    assert.equal(calls, 1)
  })

test("other GitHub conflicts remain errors", async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => ++calls === 1
    ? Response.json(publicRepository)
    : Response.json({ message: "Repository unavailable" }, { status: 409 })
  await assert.rejects(getPublicGitHubRepository("octocat", "hello-world", fetcher), (error: unknown) =>
    error instanceof GitHubRepositoryError && error.status === 502)
})
