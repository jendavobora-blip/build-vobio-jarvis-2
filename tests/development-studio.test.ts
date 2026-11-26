import assert from "node:assert/strict"
import test from "node:test"
import { createDevelopmentPlan, DEVELOPMENT_AGENTS } from "../lib/jarvis/development-studio"
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
  assert.equal(plan.steps.at(-1)?.agentId, "documentation")
  assert.ok(plan.steps.some((step) => step.agentId === "security"))
})

test("development studio rejects empty or oversized tasks", () => {
  assert.throws(() => createDevelopmentPlan(repository, "short"), /8 až 2000 znaků/)
  assert.throws(() => createDevelopmentPlan(repository, "x".repeat(2001)), /8 až 2000 znaků/)
})
