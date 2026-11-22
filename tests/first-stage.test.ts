import assert from "node:assert/strict"
import test from "node:test"
import { AGENT_ORDER } from "../lib/jarvis/agents"
import { isLiveAccessEnabled } from "../lib/jarvis/live-access"
import { filterProjects, PROJECTS } from "../lib/jarvis/projects"

test("live AI access stays off unless explicitly enabled by the server", () => {
  assert.equal(isLiveAccessEnabled(undefined), false)
  assert.equal(isLiveAccessEnabled("false"), false)
  assert.equal(isLiveAccessEnabled(" true "), true)
})

test("the prototype provides 20 uniquely identified projects", () => {
  assert.equal(PROJECTS.length, 20)
  assert.equal(new Set(PROJECTS.map((project) => project.id)).size, 20)
})

test("project search and category filters can be combined", () => {
  const results = filterProjects("paměť", "AI")
  assert.deepEqual(results.map((project) => project.id), ["memory-vault"])
  assert.equal(filterProjects("bez výsledků").length, 0)
})

test("the visualization includes all seven existing agent roles", () => {
  assert.equal(AGENT_ORDER.length, 7)
})
