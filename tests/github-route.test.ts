import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { GET } from "../app/api/github/repository/route"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("GitHub repository route validates input and uses cacheable public responses", async () => {
  let requests = 0
  globalThis.fetch = async (input) => {
    requests += 1
    const url = String(input)
    if (url.endsWith("/commits?per_page=5")) {
      return Response.json([])
    }
    return Response.json({
      full_name: "octocat/hello-world",
      description: null,
      html_url: "https://github.com/octocat/hello-world",
      default_branch: "main",
      private: false,
      stargazers_count: 7,
      open_issues_count: 2,
      updated_at: "2026-11-26T10:00:00Z",
    })
  }

  const invalid = await GET(new Request("https://jarvis.example/api/github/repository?owner=..%2Fattacker&repo=repo"))
  assert.equal(invalid.status, 400)
  assert.equal(requests, 0)

  const response = await GET(new Request("https://jarvis.example/api/github/repository?owner=octocat&repo=hello-world"))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "public, max-age=60, stale-while-revalidate=300")
  assert.equal((await response.json()).repository.fullName, "octocat/hello-world")
  assert.equal(requests, 2)
})

test("GitHub repository route returns a privacy-preserving 404 for private repositories", async () => {
  globalThis.fetch = async () => Response.json({
    full_name: "octocat/private",
    description: null,
    html_url: "https://github.com/octocat/private",
    default_branch: "main",
    private: true,
    stargazers_count: 0,
    open_issues_count: 0,
    updated_at: "2026-11-26T10:00:00Z",
  })

  const response = await GET(new Request("https://jarvis.example/api/github/repository?owner=octocat&repo=private"))
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: "Veřejný repozitář nebyl nalezen." })
})
