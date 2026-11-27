import { expect, test } from "@playwright/test"

test("preview rejects live AI calls even when the flag and credentials are configured", async ({ request }) => {
  const status = await request.get("/api/status")
  expect(status.ok()).toBeTruthy()
  expect((await status.json()).liveEnabled).toBe(false)
  expect((await status.json()).authConfigured).toBe(false)
  const chat = await request.post("/api/chat", { headers: { Origin: "http://localhost:31848" }, data: {} })
  expect(chat.status()).toBe(503)
  expect((await chat.json()).demo).toBe(true)
})

test("project selection and demo run do not call the live chat API", async ({ page }) => {
  let liveRequests = 0
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/chat") liveRequests++
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Projekty", exact: true }).click()
  await expect(page.getByRole("heading", { name: "20 připravených startů" })).toBeVisible()
  await page.getByRole("button", { name: "Použít jako zadání" }).first().click()
  await expect(page.getByLabel("Zadání pro JARVISe")).toHaveValue(/VOBIO JARVIS/)
  await page.getByRole("button", { name: "Odeslat zadání" }).click()
  await expect(page.getByText("DEMO REŽIM – simulace, žádná skutečná práce")).toBeVisible()
  await page.getByRole("button", { name: "Zastavit běh" }).click()
  expect(liveRequests).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test("iPhone viewport allows zoom and keeps key screens within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto("/")

  const viewport = await page.locator('meta[name="viewport"]').getAttribute("content") ?? ""
  expect(viewport).toContain("width=device-width")
  expect(viewport).toContain("viewport-fit=cover")
  expect(viewport).not.toMatch(/maximum-scale\s*=\s*1(?:\.0+)?|user-scalable\s*=\s*no/i)

  for (const screen of ["Agenti", "Studio", "Schválení", "Nastavení"]) {
    await page.getByRole("button", { name: screen, exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
})

test("development studio reads a public repository and prepares an honest eight-role plan without execution", async ({ page }) => {
  let liveRequests = 0
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/chat") liveRequests += 1
  })
  await page.route("**/api/github/repository**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        repository: {
          fullName: "octocat/hello-world",
          description: "A sample repository",
          url: "https://github.com/octocat/hello-world",
          defaultBranch: "main",
          stars: 7,
          openIssues: 2,
          updatedAt: "2026-11-26T10:00:00Z",
          commits: [{
            sha: "1234567890abcdef1234567890abcdef12345678",
            url: "https://github.com/octocat/hello-world/commit/1234567890abcdef1234567890abcdef12345678",
            message: "Add example",
            author: "octocat",
            date: "2026-11-26T09:00:00Z",
          }],
        },
      }),
    })
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Studio", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Osm vývojových specializací" })).toBeVisible()
  await page.getByLabel("Veřejný GitHub repozitář").fill("octocat/hello-world")
  await page.getByRole("button", { name: "Načíst", exact: true }).click()
  await expect(page.getByRole("heading", { name: "octocat/hello-world" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Add example" })).toBeVisible()
  await page.getByLabel("Vývojové zadání").fill("Add accessible repository navigation")
  await page.getByRole("button", { name: "Připravit kontrolní plán" }).click()
  await expect(page.getByRole("heading", { name: "Project Architect" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Code Reviewer" })).toBeVisible()
  await expect(page.getByRole("status")).toContainText("nevolá model")
  await page.getByRole("button", { name: "Ověřit bezpečný mock průchod" }).click()
  await expect(page.locator('p[role="alert"]')).toContainText("Nejste přihlášeni")
  expect(liveRequests).toBe(0)
})

test("studio clears stale repository and wraps long GitHub text on mobile", async ({ page }) => {
  const longName = "a".repeat(100)
  await page.route("**/api/github/repository**", async (route) => {
    await route.fulfill({ json: { repository: {
      fullName: `octocat/${longName}`,
      description: "b".repeat(500),
      url: "https://github.com/octocat/example",
      defaultBranch: "c".repeat(100),
      stars: 0,
      openIssues: 0,
      updatedAt: "2026-11-26",
      commits: [{ sha: "1".repeat(40), url: "https://github.com/octocat/example/commit/1", message: "d".repeat(240), author: "octocat", date: null }],
    } } })
  })
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto("/")
  await page.getByRole("button", { name: "Studio", exact: true }).click()
  await page.getByLabel("Veřejný GitHub repozitář").fill(`octocat/${longName}`)
  await page.getByRole("button", { name: "Načíst", exact: true }).click()
  await expect(page.getByRole("heading", { name: `octocat/${longName}` })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByLabel("Veřejný GitHub repozitář").fill("octocat/other")
  await expect(page.getByRole("heading", { name: `octocat/${longName}` })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Připravit kontrolní plán" })).toBeDisabled()
})

test("studio history loads persisted mock events and clears them when access expires", async ({ page }) => {
  const first = "00000000-0000-4000-8000-000000000001"
  const second = "00000000-0000-4000-8000-000000000002"
  let allowed = true
  let releaseFirst!: () => void
  let firstStarted!: () => void
  let firstFinished!: () => void
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
  const firstSeen = new Promise<void>((resolve) => { firstStarted = resolve })
  const firstDone = new Promise<void>((resolve) => { firstFinished = resolve })
  await page.route("**/api/development-studio/runs**", async (route) => {
    if (!allowed) {
      await route.fulfill({ status: 401, json: { error: "Nejste přihlášeni." } })
      return
    }
    const runId = new URL(route.request().url()).searchParams.get("runId")
    if (!runId) {
      await route.fulfill({ json: { runs: [first, second].map((id, index) => ({
        id, repository: `octocat/repo-${index}`, mode: "mock_only", status: "blocked", created_at: "2026-11-26T10:00:00Z",
      })) } })
      return
    }
    if (runId === first) {
      firstStarted()
      await firstBlocked
    }
    await route.fulfill({ json: { events: [{
      id: `${runId}:0`, runId, sequence: 0, agentId: runId === first ? "architect" : "qa",
      event: "agent_mocked", detailCode: "mock_only", occurredAt: "2026-11-26T10:00:00Z",
    }] } }).catch(() => {})
    if (runId === first) firstFinished()
  })
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto("/")
  await page.getByRole("button", { name: "Studio", exact: true }).click()
  await page.getByRole("button", { name: "Načíst historii" }).click()
  await expect(page.getByText("octocat/repo-0")).toBeVisible()
  const detail = page.getByRole("button", { name: "Zobrazit události" })
  await detail.nth(0).click()
  await firstSeen
  await detail.nth(1).click()
  const events = page.getByRole("list", { name: "Uložené události mock průchodu" })
  await expect(events).toContainText("QA Engineer")
  releaseFirst()
  await firstDone
  await expect(events).toContainText("QA Engineer")
  await expect(events).not.toContainText("Project Architect")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  allowed = false
  await page.getByRole("button", { name: "Načíst historii" }).click()
  await expect(page.locator('p[role="alert"]')).toContainText("Nejste přihlášeni")
  await expect(page.getByText("octocat/repo-0")).toHaveCount(0)
  await expect(events).toHaveCount(0)
})

test("studio history rejects unauthenticated access", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Studio", exact: true }).click()
  await page.getByRole("button", { name: "Načíst historii" }).click()
  await expect(page.locator('p[role="alert"]')).toContainText("Nejste přihlášeni")
  await expect(page.getByRole("list", { name: "Uložené mock průchody" })).toHaveCount(0)
})

test("studio clears displayed history immediately on logout", async ({ page }) => {
  let authenticated = true
  await page.route("**/api/status", async (route) => route.fulfill({ json: {
    deepseekConfigured: false, liveEnabled: false, authConfigured: true, authenticated,
    userRole: "member", databaseConfigured: false,
    limits: { maxRequestUsd: 0, maxRequestTokens: 0, dailyBudgetUsd: 0, runsPer10Min: 0 }, usageToday: null,
  } }))
  await page.route("**/api/auth", async (route) => {
    authenticated = false
    await route.fulfill({ json: { ok: true } })
  })
  await page.route("**/api/github/repository**", async (route) => route.fulfill({ json: { repository: {
    fullName: "octocat/old-repository", description: "Old account description", url: "https://github.com/octocat/old-repository",
    defaultBranch: "main", stars: 0, openIssues: 0, commits: [],
  } } }))
  await page.route("**/api/development-studio/runs**", async (route) => route.fulfill({ json: { runs: [{
    id: "00000000-0000-4000-8000-000000000001", repository: "octocat/private-history", mode: "mock_only",
    status: "blocked", created_at: "2026-11-26T10:00:00Z",
  }] } }))
  await page.goto("/")
  await page.getByRole("button", { name: "Studio", exact: true }).click()
  await page.getByLabel("Veřejný GitHub repozitář").fill("octocat/old-repository")
  await page.getByRole("button", { name: "Načíst", exact: true }).click()
  await expect(page.getByText("Old account description")).toBeVisible()
  await page.getByLabel("Vývojové zadání").fill("Private task for old account")
  await page.getByRole("button", { name: "Připravit kontrolní plán" }).click()
  await expect(page.getByRole("status")).toContainText("nevolá model")
  await page.getByRole("button", { name: "Načíst historii" }).click()
  await expect(page.getByText("octocat/private-history")).toBeVisible()
  await page.getByRole("button", { name: "Demo režim – otevřít nastavení" }).click()
  await page.getByRole("button", { name: "Odhlásit se" }).click()
  await expect(page.getByText("octocat/private-history")).toHaveCount(0)
  await expect(page.getByText("Old account description")).toHaveCount(0)
  await expect(page.getByRole("status")).toHaveCount(0)
  await expect(page.getByLabel("Veřejný GitHub repozitář")).toHaveValue("")
  await expect(page.getByLabel("Vývojové zadání")).toHaveValue("")
})

test("studio clears previous account history when switching browser tabs", async ({ page, context }) => {
  let scope = "account-a"
  await context.route("**/api/status", async (route) => route.fulfill({ json: {
    deepseekConfigured: false, liveEnabled: false, authConfigured: true, authenticated: true, accountScope: scope,
    userRole: "member", databaseConfigured: false,
    limits: { maxRequestUsd: 0, maxRequestTokens: 0, dailyBudgetUsd: 0, runsPer10Min: 0 }, usageToday: null,
  } }))
  await context.route("**/api/development-studio/runs**", async (route) => route.fulfill({ json: { runs: [{
    id: "00000000-0000-4000-8000-000000000001", repository: `octocat/${scope}`, mode: "mock_only",
    status: "blocked", created_at: "2026-11-26T10:00:00Z",
  }] } }))
  await context.route("**/api/auth", async (route) => {
    scope = "account-b"
    await route.fulfill({ json: { ok: true } })
  })
  await context.route("**/api/github/repository**", async (route) => route.fulfill({ json: { repository: {
    fullName: "octocat/account-a-repository", description: "Account A repository", url: "https://github.com/octocat/account-a-repository",
    defaultBranch: "main", stars: 0, openIssues: 0, commits: [],
  } } }))
  await page.goto("/")
  await page.getByRole("button", { name: "Studio", exact: true }).click()
  await page.getByLabel("Veřejný GitHub repozitář").fill("octocat/account-a-repository")
  await page.getByRole("button", { name: "Načíst", exact: true }).click()
  await expect(page.getByText("Account A repository")).toBeVisible()
  await page.getByLabel("Vývojové zadání").fill("Account A private task")
  await page.getByRole("button", { name: "Připravit kontrolní plán" }).click()
  await expect(page.getByRole("status")).toContainText("nevolá model")
  await page.getByRole("button", { name: "Načíst historii" }).click()
  await expect(page.getByText("octocat/account-a", { exact: true })).toBeVisible()
  const otherTab = await context.newPage()
  await otherTab.goto("/")
  await otherTab.getByRole("button", { name: "Demo režim – otevřít nastavení" }).click()
  await otherTab.getByRole("button", { name: "Odhlásit se" }).click()
  await expect(page.getByText("octocat/account-a", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Account A repository")).toHaveCount(0)
  await expect(page.getByRole("status")).toHaveCount(0)
  await expect(page.getByLabel("Veřejný GitHub repozitář")).toHaveValue("")
  await expect(page.getByLabel("Vývojové zadání")).toHaveValue("")
  await page.getByRole("button", { name: "Načíst historii" }).click()
  await expect(page.getByText("octocat/account-b")).toBeVisible()
  await otherTab.close()
})

test("studio aborts an unfinished mock run when another tab changes session", async ({ page }) => {
  let release!: () => void
  let started!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const seen = new Promise<void>((resolve) => { started = resolve })
  await page.route("**/api/github/repository**", async (route) => route.fulfill({ json: { repository: {
    fullName: "octocat/pending", description: "Pending repository", url: "https://github.com/octocat/pending",
    defaultBranch: "main", stars: 0, openIssues: 0, commits: [],
  } } }))
  await page.route("**/api/development-studio/runs", async (route) => {
    started()
    await blocked
    await route.fulfill({ json: { events: [{ id: "old-result", agentId: "qa", event: "agent_mocked", detailCode: "old-result" }] } }).catch(() => {})
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Studio", exact: true }).click()
  await page.getByLabel("Veřejný GitHub repozitář").fill("octocat/pending")
  await page.getByRole("button", { name: "Načíst", exact: true }).click()
  await expect(page.getByText("Pending repository")).toBeVisible()
  await page.getByLabel("Vývojové zadání").fill("Pending account task")
  await page.getByRole("button", { name: "Připravit kontrolní plán" }).click()
  await page.getByRole("button", { name: "Ověřit bezpečný mock průchod" }).click()
  await seen
  const failed = page.waitForEvent("requestfailed", (request) => request.url().endsWith("/api/development-studio/runs"))
  await page.evaluate(() => {
    const channel = new BroadcastChannel("vobio-jarvis-auth")
    channel.postMessage("session-changed")
    channel.close()
  })
  await failed
  await expect(page.getByLabel("Vývojové zadání")).toHaveValue("")
  release()
  await expect(page.getByText("old-result")).toHaveCount(0)
  await expect(page.getByText("Pending repository")).toHaveCount(0)
})

test("account change hides previous cloud and device memories and clears the running result", async ({ page }) => {
  let scope: string | null = "account-a"
  await page.route("**/api/status", async (route) => route.fulfill({ json: {
    deepseekConfigured: false, liveEnabled: false, authConfigured: true, authenticated: Boolean(scope),
    accountScope: scope ?? undefined, userRole: "member", databaseConfigured: true,
    limits: { maxRequestUsd: 0, maxRequestTokens: 0, dailyBudgetUsd: 0, runsPer10Min: 0 }, usageToday: null,
  } }))
  await page.route("**/api/memory", async (route) => route.fulfill({ json: { items: [{
    id: "cloud-memory", title: `Cloud ${scope}`, content: "Account data", category: "preferences",
    sensitive: true, createdAt: "2026-11-26T10:00:00Z", updatedAt: "2026-11-26T10:00:00Z",
  }] } }))
  await page.goto("/")
  await page.getByRole("button", { name: "Paměť", exact: true }).click()
  await expect(page.getByText("Cloud account-a")).toBeVisible()
  await page.getByRole("button", { name: "Spravovat paměť" }).click()
  await page.getByRole("button", { name: "Nová položka" }).click()
  await page.getByLabel("Název", { exact: true }).fill("Device account A")
  await page.getByLabel("Obsah", { exact: true }).fill("Private device data")
  await page.getByRole("button", { name: "Uložit", exact: true }).click()
  await expect(page.getByRole("dialog").getByText("Device account A")).toBeVisible()
  await page.getByRole("button", { name: "Upravit Device account A" }).click()
  await expect(page.getByRole("textbox", { name: "Obsah", exact: true })).toHaveValue("Private device data")

  scope = "account-b"
  await page.evaluate(() => {
    const channel = new BroadcastChannel("vobio-jarvis-auth")
    channel.postMessage("session-changed")
    channel.close()
  })
  await expect(page.getByText("Cloud account-a")).toHaveCount(0)
  await expect(page.getByText("Device account A")).toHaveCount(0)
  await expect(page.getByRole("dialog").getByText("Cloud account-b")).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Obsah", exact: true })).toHaveCount(0)
  scope = null
  await page.evaluate(() => {
    const channel = new BroadcastChannel("vobio-jarvis-auth")
    channel.postMessage("session-changed")
    channel.close()
  })
  await expect(page.getByText("Cloud account-b")).toHaveCount(0)
  await expect(page.getByText("Device account A")).toHaveCount(0)
})

test("session change clears a previous chat prompt and demo result", async ({ page }) => {
  await page.goto("/")
  await page.getByLabel("Zadání pro JARVISe").fill("Private previous account prompt")
  await page.getByRole("button", { name: "Odeslat zadání" }).click()
  await expect(page.getByText("Výsledek · DEMO")).toBeVisible()
  await page.evaluate(() => {
    const channel = new BroadcastChannel("vobio-jarvis-auth")
    channel.postMessage("session-changed")
    channel.close()
  })
  await expect(page.getByText("Výsledek · DEMO")).toHaveCount(0)
  await expect(page.getByText("Private previous account prompt")).toHaveCount(0)
  await page.getByRole("button", { name: "Velín", exact: true }).click()
  await expect(page.getByLabel("Zadání pro JARVISe")).toHaveValue("")
})

test("failed session refresh keeps account data hidden until retry succeeds", async ({ page }) => {
  let scope = "account-a"
  let unavailable = false
  await page.route("**/api/status", async (route) => {
    if (unavailable) return route.fulfill({ status: 503, json: { error: "Unavailable" } })
    await route.fulfill({ json: {
      deepseekConfigured: false, liveEnabled: false, authConfigured: true, authenticated: true, accountScope: scope,
      databaseConfigured: true, limits: { maxRequestUsd: 0, maxRequestTokens: 0, dailyBudgetUsd: 0, runsPer10Min: 0 }, usageToday: null,
    } })
  })
  await page.route("**/api/memory", async (route) => route.fulfill({ json: { items: [{
    id: "cloud-memory", title: `Cloud ${scope}`, content: "Account data", category: "preferences",
    sensitive: true, createdAt: "2026-11-26T10:00:00Z", updatedAt: "2026-11-26T10:00:00Z",
  }] } }))
  await page.goto("/")
  await page.getByRole("button", { name: "Paměť", exact: true }).click()
  await expect(page.getByText("Cloud account-a")).toBeVisible()
  scope = "account-b"
  unavailable = true
  await page.evaluate(() => {
    const channel = new BroadcastChannel("vobio-jarvis-auth")
    channel.postMessage("session-changed")
    channel.close()
  })
  await expect(page.locator("p[role=alert]")).toContainText("Stav přihlášení nelze ověřit")
  await expect(page.getByText("Cloud account-a")).toHaveCount(0)
  unavailable = false
  await page.getByRole("button", { name: "Zkusit znovu" }).click()
  await expect(page.getByText("Cloud account-b")).toBeVisible()
  await expect(page.getByText("Cloud account-a")).toHaveCount(0)
})

test("session changes synchronize without BroadcastChannel", async ({ page, context }) => {
  let scope: string | null = "account-a"
  await context.addInitScript(() => { Object.defineProperty(window, "BroadcastChannel", { value: undefined }) })
  await context.route("**/api/status", async (route) => route.fulfill({ json: {
    deepseekConfigured: false, liveEnabled: false, authConfigured: true, authenticated: Boolean(scope), accountScope: scope ?? undefined,
    databaseConfigured: true, limits: { maxRequestUsd: 0, maxRequestTokens: 0, dailyBudgetUsd: 0, runsPer10Min: 0 }, usageToday: null,
  } }))
  await context.route("**/api/memory", async (route) => route.fulfill({ json: { items: [{
    id: "cloud-memory", title: `Cloud ${scope}`, content: "Account data", category: "preferences",
    sensitive: true, createdAt: "2026-11-26T10:00:00Z", updatedAt: "2026-11-26T10:00:00Z",
  }] } }))
  await context.route("**/api/auth", async (route) => {
    scope = null
    await route.fulfill({ json: { ok: true } })
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Paměť", exact: true }).click()
  await expect(page.getByText("Cloud account-a")).toBeVisible()
  const other = await context.newPage()
  await other.goto("/")
  await other.getByRole("button", { name: "Demo režim – otevřít nastavení" }).click()
  await other.getByRole("button", { name: "Odhlásit se" }).click()
  await page.bringToFront()
  await expect(page.getByText("Cloud account-a")).toHaveCount(0)
  await other.close()
})

test("legacy unscoped local memory is not exposed after logout", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vobio-jarvis.memory.v1", JSON.stringify([{
    id: "legacy", title: "Legacy private memory", content: "Old account data", category: "history",
    sensitive: false, createdAt: "2026-11-26T10:00:00Z", updatedAt: "2026-11-26T10:00:00Z",
  }])))
  await page.goto("/")
  await page.getByRole("button", { name: "Paměť", exact: true }).click()
  await expect(page.getByText("Legacy private memory")).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem("vobio-jarvis.memory.v1"))).toContain("Legacy private memory")
})

test("account change cancels a multi-item cloud memory import", async ({ page }) => {
  let scope = "account-a"
  let writes = 0
  let release!: () => void
  let started!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const seen = new Promise<void>((resolve) => { started = resolve })
  await page.route("**/api/status", async (route) => route.fulfill({ json: {
    deepseekConfigured: false, liveEnabled: false, authConfigured: true, authenticated: true, accountScope: scope,
    databaseConfigured: true, limits: { maxRequestUsd: 0, maxRequestTokens: 0, dailyBudgetUsd: 0, runsPer10Min: 0 }, usageToday: null,
  } }))
  await page.route("**/api/memory", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { items: [] } })
    writes += 1
    expect(route.request().headers()["x-jarvis-account-scope"]).toBe("account-a")
    started()
    await blocked
    await route.fulfill({ json: { ok: true } }).catch(() => {})
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Paměť", exact: true }).click()
  await page.getByRole("button", { name: "Spravovat paměť" }).click()
  await page.locator('input[type="file"]').setInputFiles({
    name: "memories.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ items: [1, 2].map((id) => ({
      id: String(id), title: `Private ${id}`, content: "Account A", category: "history", sensitive: true,
    })) })),
  })
  await seen
  const failed = page.waitForEvent("requestfailed", (request) => request.url().endsWith("/api/memory") && request.method() === "PUT")
  scope = "account-b"
  await page.evaluate(() => {
    const channel = new BroadcastChannel("vobio-jarvis-auth")
    channel.postMessage("session-changed")
    channel.close()
  })
  await failed
  release()
  await expect(page.getByRole("dialog").getByText("Private 2")).toHaveCount(0)
  expect(writes).toBe(1)
})

test("account change clears approval plans and invitation tokens", async ({ page }) => {
  let scope: string | null = "owner-a"
  await page.route("**/api/status", async (route) => route.fulfill({ json: {
    deepseekConfigured: false, liveEnabled: false, authConfigured: true, authenticated: Boolean(scope), accountScope: scope ?? undefined,
    userRole: "owner", databaseConfigured: true,
    limits: { maxRequestUsd: 0, maxRequestTokens: 0, dailyBudgetUsd: 0, runsPer10Min: 0 }, usageToday: null,
  } }))
  await page.route("**/api/approvals", async (route) => route.fulfill({ json: {
    items: scope ? [{ id: "a", plan_hash: "hash", plan_json: JSON.stringify({
      target: "Account A target", action: "Account A plan", changes: [], impacts: [], critical: false,
    }), status: "pending" }] : [], audit: [],
  } }))
  await page.route("**/api/accounts", async (route) => route.fulfill({ json: { items: [] } }))
  await page.route("**/api/accounts/invitations", async (route) => route.fulfill({ json: { token: "private-invitation-token" } }))
  await page.goto("/")
  await page.getByRole("button", { name: "Schválení", exact: true }).click()
  await expect(page.getByText("Account A plan")).toBeVisible()
  await page.getByLabel("Cílový systém").fill("Private draft")
  await page.getByRole("button", { name: "Demo režim – otevřít nastavení" }).click()
  await page.getByLabel("E-mail pro pozvánku").fill("test@example.test")
  await page.getByRole("button", { name: "Vytvořit pozvánku" }).click()
  await expect(page.getByText("private-invitation-token")).toBeVisible()
  scope = null
  await page.evaluate(() => {
    const channel = new BroadcastChannel("vobio-jarvis-auth")
    channel.postMessage("session-changed")
    channel.close()
  })
  await expect(page.getByText("private-invitation-token")).toHaveCount(0)
  await expect(page.getByText("Account A plan")).toHaveCount(0)
  await expect(page.getByLabel("Cílový systém")).toHaveValue("")
})

test("memory search filters persisted local items by content", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Paměť", exact: true }).click()
  await page.getByRole("button", { name: "Spravovat paměť" }).click()
  await page.getByRole("button", { name: "Nová položka" }).click()
  await page.getByLabel("Název", { exact: true }).fill("Testovací položka")
  await page.getByLabel("Obsah", { exact: true }).fill("Česká paměť")
  await page.getByRole("button", { name: "Uložit", exact: true }).click()
  await expect(page.getByRole("dialog").getByText("Testovací položka")).toBeVisible()
  await page.getByLabel("Hledat v paměti").fill("ČESKÁ")
  await expect(page.getByRole("dialog").getByText("Testovací položka")).toBeVisible()
  await page.getByLabel("Hledat v paměti").fill("neexistuje")
  await expect(page.getByText("Žádné položky neodpovídají filtru.")).toBeVisible()
  await page.reload()
  await page.getByRole("button", { name: "Paměť", exact: true }).click()
  await page.getByRole("button", { name: "Spravovat paměť" }).click()
  await expect(page.getByRole("dialog").getByText("Testovací položka")).toBeVisible()
})

test("reduced motion presents the accessible agent cards instead of WebGL animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")
  await page.getByRole("button", { name: "Agenti", exact: true }).click()
  await expect(page.getByText(/Omezení pohybu je zapnuto/)).toBeVisible()
  const card = page.getByRole("button", { name: /Router:.*Otevřít detail/ })
  await expect(card).toBeVisible()
  await card.click()
  await expect(page.getByRole("dialog", { name: "Router" })).toBeVisible()
})

test("WebGL node selection and context loss preserve the agent controls", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Agenti", exact: true }).click()
  const status = page.locator("main [role='status']").last()
  await expect(status).toContainText(/3D WebGL|3D není dostupné/, { timeout: 15000 })
  test.skip((await status.textContent())?.includes("3D není dostupné") ?? false, "WebGL není v tomto prohlížeči dostupné.")
  const canvas = page.locator("main canvas")
  const bounds = await canvas.boundingBox()
  if (!bounds) throw new Error("3D plátno není viditelné.")
  await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } })
  await expect(page.getByRole("dialog", { name: "Router" })).toBeVisible()
  await page.getByRole("button", { name: "Zavřít", exact: true }).click()
  await canvas.evaluate((element) => element.dispatchEvent(new Event("webglcontextlost", { cancelable: true })))
  await expect(status).toContainText("3D není dostupné")
  await expect(page.getByRole("button", { name: /Router:.*Otevřít detail/ })).toBeVisible()
})

test("orchestration submission displays the result panel", async ({ page }) => {
  await page.goto("/")
  await page.getByLabel("Zadání pro JARVISe").fill("Ukázkový průchod výsledkem")
  await page.getByRole("button", { name: "Odeslat zadání" }).click()
  await page.getByRole("button", { name: "Tok", exact: true }).click()
  await expect(page.getByText("Výsledek · DEMO")).toBeVisible({ timeout: 15000 })
})

test("unsupported voice recognition returns to the text composer", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: undefined })
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: undefined })
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Hlas", exact: true }).click()
  await page.getByRole("button", { name: "Začít diktovat" }).click()
  await expect(page.getByLabel("Zadání pro JARVISe")).toBeVisible()
  await expect(page.getByLabel("Zadání pro JARVISe")).toBeFocused()
})

test("approvals screen is visible but unauthenticated plans cannot be stored", async ({ page }) => {
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/approvals") && response.request().method() === "POST",
  )
  await page.goto("/")
  await page.getByRole("button", { name: "Schválení", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Schválení konkrétních plánů" })).toBeVisible()
  await page.getByLabel("Cílový systém").fill("GitHub")
  await page.getByLabel("Akce", { exact: true }).fill("Vytvořit pull request")
  await page.getByLabel(/Změny/).fill("Upravit zdrojový kód")
  await page.getByLabel(/Dopady/).fill("Pouze návrh v samostatné větvi")
  await page.getByRole("button", { name: "Předložit ke schválení" }).click()
  expect((await responsePromise).status()).toBe(401)
  await expect(page.getByText("Nejste přihlášeni.", { exact: true })).toBeVisible()
})

test("unauthenticated visitors cannot manage accounts or create invitations", async ({ page }) => {
  await page.goto("/")
  const accounts = await page.request.get("/api/accounts")
  expect(accounts.status()).toBe(403)

  const invitation = await page.request.post("/api/accounts/invitations", {
    headers: { Origin: new URL(page.url()).origin },
    data: { email: "member@example.test" },
  })
  expect(invitation.status()).toBe(403)
})

test("state-changing APIs reject cross-origin requests", async ({ page }) => {
  await page.goto("/")
  const csrfHeaders = { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" }
  const login = await page.request.post("/api/auth", { headers: csrfHeaders, data: { code: "incorrect-test-code" } })
  expect(login.status()).toBe(403)
  const memory = await page.request.put("/api/memory", { headers: csrfHeaders, data: {} })
  expect(memory.status()).toBe(403)
})
