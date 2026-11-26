import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { GET } from "../app/api/github/repository/route"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test("GitHub route coalesces concurrent requests and shares the outbound quota across clients", async () => {
  let outbound = 0
  globalThis.fetch = async (input) => {
    outbound += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (String(input).includes("/commits?")) return Response.json([])
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
  const request = (repo: string, ip: string) => new Request(
    `https://jarvis.example/api/github/repository?owner=octocat&repo=${repo}`,
    { headers: { "x-real-ip": ip } },
  )
  const responses = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    GET(request("hello-world", `192.0.2.${index + 1}`))))
  assert.ok(responses.every((response) => response.status === 200))
  assert.equal(outbound, 2)

  for (let index = 0; index < 9; index += 1) {
    assert.equal((await GET(request(`unique-${index}`, `192.0.2.${index + 20}`))).status, 200)
  }
  assert.equal((await GET(request("one-too-many", "192.0.2.99"))).status, 429)
  assert.equal(outbound, 20)
})
