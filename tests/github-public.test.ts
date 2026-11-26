import assert from "node:assert/strict"
import test from "node:test"
import {
  getPublicGitHubRepository,
  GitHubRepositoryError,
  isValidRepositoryPath,
} from "../lib/github/public-repository"

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
  assert.equal(isValidRepositoryPath("../attacker", "repo"), false)
  assert.equal(isValidRepositoryPath("octocat", ".."), false)

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
