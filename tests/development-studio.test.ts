import assert from "node:assert/strict"
import test from "node:test"
import {
  createDevelopmentPlan,
  createMockDevelopmentStudioRun,
  DEVELOPMENT_AGENTS,
  DisabledIsolatedCodeExecutor,
  type DevelopmentAgentId,
} from "../lib/jarvis/development-studio"
import type { PublicGitHubRepository } from "../lib/github/public-repository"

const repository: PublicGitHubRepository = {
  fullName: "octocat/hello-world",
  description: null,
  url: "https://github.com/octocat/hello-world",
  defaultBranch: "main",
  stars: 0,
  openIssues: 0,
  updatedAt: "2026-11-26T10:00:00Z",
  commits: [],
}

test("development studio prepares one bounded, transparent step for each of eight roles", () => {
  const plan = createDevelopmentPlan(repository, "Add accessible repository navigation")

  assert.equal(DEVELOPMENT_AGENTS.length, 8)
  assert.equal(plan.steps.length, 8)
  assert.equal(plan.repository, repository.fullName)
  assert.equal(plan.steps.at(-1)?.agentId, "reviewer")
  assert.deepEqual(DEVELOPMENT_AGENTS.map((agent) => agent.id), [
    "architect", "frontend", "backend", "ai", "security", "qa", "devops", "reviewer",
  ])
  assert.ok(plan.steps.some((step) => step.agentId === "security"))
})

test("development studio rejects empty or oversized tasks", () => {
  assert.throws(() => createDevelopmentPlan(repository, "short"), /8 až 2000 znaků/)
  assert.throws(() => createDevelopmentPlan(repository, "x".repeat(2001)), /8 až 2000 znaků/)
})

test("mock Studio backend records eight simulated roles and refuses code execution", async () => {
  const invoked: DevelopmentAgentId[] = []
  const prompt = "Do not expose this task in audit events"
  const run = await createMockDevelopmentStudioRun({
    id: "00000000-0000-4000-8000-000000000001",
    repository: repository.fullName,
    task: prompt,
    taskHash: "a".repeat(64),
    now: () => new Date("2026-11-26T10:00:00.000Z"),
    provider: {
      mode: "mock",
      async runAgent({ agentId }) {
        invoked.push(agentId)
      },
    },
    executor: new DisabledIsolatedCodeExecutor(),
  })

  assert.equal(run.mode, "mock_only")
  assert.equal(run.status, "blocked")
  assert.equal(run.events.length, 19)
  assert.deepEqual(invoked, DEVELOPMENT_AGENTS.map((agent) => agent.id))
  assert.equal(run.events.at(-1)?.detailCode, "sandbox_not_configured")
  assert.equal(JSON.stringify(run.events).includes(prompt), false)
})

test("mock Studio rejects invalid repository paths and refuses an active executor", async () => {
  const input = {
    id: "00000000-0000-4000-8000-000000000002",
    repository: "octocat/hello-world",
    task: "Add safe mock run",
    taskHash: "b".repeat(64),
  }
  await assert.rejects(
    createMockDevelopmentStudioRun({ ...input, repository: "octocat/private/repo" }),
    /platný veřejný repozitář/,
  )
  await assert.rejects(
    createMockDevelopmentStudioRun({
      ...input,
      executor: { async execute() { return { executed: true, reason: "sandbox_not_configured" } } },
    }),
    /Executor nesmí provést kód/,
  )

  let liveCalls = 0
  await assert.rejects(
    createMockDevelopmentStudioRun({
      ...input,
      provider: {
        mode: "live",
        async runAgent() {
          liveCalls += 1
        },
      },
    }),
    /Živý vývojový model není v této etapě povolen/,
  )
  assert.equal(liveCalls, 0)
})
