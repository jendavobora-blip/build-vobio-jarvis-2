import assert from "node:assert/strict"
import test from "node:test"
import { AGENT_ORDER } from "../lib/jarvis/agents"
import { isLiveAccessEnabled } from "../lib/jarvis/live-access"
import { filterProjects, PROJECTS } from "../lib/jarvis/projects"
import { nextGraphicsQuality } from "../lib/jarvis/graphics-quality"
import { filterMemories } from "../lib/jarvis/memory-filter"
import { readFileSync } from "node:fs"
import { approvalHash, approvalPlanSchema } from "../lib/server/approvals"

test("live AI access stays off unless explicitly enabled by the server", () => {
  assert.equal(isLiveAccessEnabled(undefined), false)
  assert.equal(isLiveAccessEnabled("false"), false)
  assert.equal(isLiveAccessEnabled(" true "), true)
  assert.equal(isLiveAccessEnabled("true", "preview"), false)
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

test("graphics quality degrades progressively only on sustained low performance", () => {
  assert.equal(nextGraphicsQuality("high", 60), "high")
  assert.equal(nextGraphicsQuality("high", 44), "low")
  assert.equal(nextGraphicsQuality("low", 30), "low")
  assert.equal(nextGraphicsQuality("low", 23), "fallback")
  assert.equal(nextGraphicsQuality("high", Number.NaN), "high")
})

test("memory search combines title or content with category", () => {
  const items = [
    { category: "projects" as const, title: "JARVIS", content: "Hlasové ovládání" },
    { category: "preferences" as const, title: "Hlas", content: "Česky" },
  ]
  assert.deepEqual(filterMemories(items, "projects", " HLAS "), [items[0]])
  assert.deepEqual(filterMemories(items, "all", "česky"), [items[1]])
  assert.deepEqual(filterMemories(items, "tasks", ""), [])
})

test("DeepSeek workflow rejects staged, unstaged, and untracked workflow changes", () => {
  const workflow = readFileSync(".github/workflows/deepseek-coder.yml", "utf8")
  assert.match(workflow, /git status --porcelain=v1 -- \.github\/workflows/)
  assert.doesNotMatch(workflow, /git diff --name-only -- \.github\/workflows/)
})

test("approval plans are immutable and require an exact plan hash", () => {
  const plan = approvalPlanSchema.parse({
    target: "GitHub",
    action: "Create pull request",
    changes: ["Update src/app.ts"],
    impacts: ["No production deployment"],
    critical: false,
  })
  const hash = approvalHash(plan)
  assert.equal(hash.length, 43)
  assert.notEqual(hash, approvalHash({ ...plan, action: "Merge pull request" }))
})
