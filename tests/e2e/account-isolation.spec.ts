import { expect, test, type Page } from "@playwright/test"
import { randomUUID } from "node:crypto"

const origin = "http://localhost:31849"
const email = `member-${randomUUID()}@example.test`
const password = "synthetic-member-password"
const suffix = randomUUID().slice(0, 8)
const ownerLabel = `Owner-${suffix}`
const memberLabel = `Member-${suffix}`

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Demo režim – otevřít nastavení" }).click()
}

async function login(page: Page, role: "owner" | "member") {
  await openSettings(page)
  if (role === "owner") {
    await page.getByLabel("Přístupový kód vlastníka (nebo účet pozvaného uživatele)").fill("e2e-owner-code")
  } else {
    await page.getByLabel("E-mail pozvaného uživatele").fill(email)
    await page.getByLabel("Heslo účtu (min. 12 znaků)").fill(password)
  }
  const response = page.waitForResponse((response) => response.url().endsWith("/api/auth") && response.request().method() === "POST")
  await page.getByRole("button", { name: "Přihlásit", exact: true }).click()
  expect((await response).status()).toBe(200)
  await expect(page.getByRole("button", { name: "Odhlásit se" })).toBeVisible()
  await page.keyboard.press("Escape")
}

async function seed(page: Page, scope: string, label: string) {
  const now = new Date().toISOString()
  const memory = await page.request.put("/api/memory", {
    headers: { Origin: origin, "X-Jarvis-Account-Scope": scope },
    data: { id: randomUUID(), category: "preferences", title: `${label} memory`, content: `${label} synthetic content`, sensitive: false, createdAt: now, updatedAt: now },
  })
  expect(memory.status()).toBe(200)
  const run = await page.request.post("/api/development-studio/runs", {
    headers: { Origin: origin },
    data: { idempotencyKey: randomUUID(), repository: `example/${label.toLowerCase()}-repo`, task: `${label} synthetic development task` },
  })
  expect(run.status()).toBe(201)
  return (await run.json()).run.id as string
}

async function checkApi(page: Page, scope: string, otherScope: string, own: string, other: string, otherRun: string) {
  const memory = await page.request.get("/api/memory", { headers: { "X-Jarvis-Account-Scope": scope } })
  expect(memory.status()).toBe(200)
  const items = (await memory.json()).items as { title: string }[]
  expect(items.map((item) => item.title)).toContain(`${own} memory`)
  expect(items.map((item) => item.title)).not.toContain(`${other} memory`)
  expect((await page.request.get("/api/memory", { headers: { "X-Jarvis-Account-Scope": otherScope } })).status()).toBe(409)
  const history = await page.request.get("/api/development-studio/runs")
  expect(history.status()).toBe(200)
  const runs = (await history.json()).runs as { repository: string }[]
  expect(runs.map((run) => run.repository)).toContain(`example/${own.toLowerCase()}-repo`)
  expect(runs.map((run) => run.repository)).not.toContain(`example/${other.toLowerCase()}-repo`)
  expect((await page.request.get(`/api/development-studio/runs?runId=${otherRun}`)).status()).toBe(404)
}

async function checkUi(page: Page, own: string, other: string) {
  await page.getByRole("button", { name: "Paměť", exact: true }).click()
  await expect(page.getByText(`${own} memory`, { exact: true })).toBeVisible()
  await expect(page.getByText(`${other} memory`, { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Studio", exact: true }).click()
  await page.getByRole("button", { name: "Načíst historii" }).click()
  await expect(page.getByText(`example/${own.toLowerCase()}-repo`, { exact: true })).toBeVisible()
  await expect(page.getByText(`example/${other.toLowerCase()}-repo`, { exact: true })).toHaveCount(0)
}

test("real account sessions isolate memory and Studio history across tabs and revoke deactivated members", async ({ page, context, browser }) => {
  test.setTimeout(120_000)
  await page.goto("/")
  await login(page, "owner")
  const ownerStatus = await (await page.request.get("/api/status")).json()
  expect(ownerStatus.userRole).toBe("owner")
  expect(ownerStatus.liveEnabled).toBe(false)
  const ownerRun = await seed(page, ownerStatus.accountScope, ownerLabel)

  const invitation = await page.request.post("/api/accounts/invitations", { headers: { Origin: origin }, data: { email } })
  expect(invitation.status()).toBe(201)
  const { token } = await invitation.json()
  const enrollment = await browser.newContext({ baseURL: origin })
  const redeem = await enrollment.request.post("/api/accounts/invitations/redeem", { headers: { Origin: origin }, data: { email, token, password } })
  expect(redeem.status()).toBe(200)
  const memberStatus = await (await enrollment.request.get("/api/status")).json()
  expect(memberStatus.userRole).toBe("member")
  expect(memberStatus.accountScope).not.toBe(ownerStatus.accountScope)
  const enrollmentPage = await enrollment.newPage()
  const memberRun = await seed(enrollmentPage, memberStatus.accountScope, memberLabel)
  await checkApi(enrollmentPage, memberStatus.accountScope, ownerStatus.accountScope, memberLabel, ownerLabel, ownerRun)
  await enrollment.close()
  const accounts = await (await page.request.get("/api/accounts")).json()
  const member = accounts.items.find((item: { email: string }) => item.email === email)
  expect(member).toBeTruthy()
  const control = await browser.newContext({ baseURL: origin, storageState: await context.storageState() })

  await page.reload()
  await checkApi(page, ownerStatus.accountScope, memberStatus.accountScope, ownerLabel, memberLabel, memberRun)
  await checkUi(page, ownerLabel, memberLabel)
  const second = await context.newPage()
  await second.goto("/")
  await openSettings(second)
  const logout = second.waitForResponse((response) => response.url().endsWith("/api/auth") && response.request().method() === "DELETE")
  await second.getByRole("button", { name: "Odhlásit se" }).click()
  expect((await logout).status()).toBe(200)
  await expect(page.getByText(`example/${ownerLabel.toLowerCase()}-repo`, { exact: true })).toHaveCount(0)
  await second.keyboard.press("Escape")
  await login(second, "member")
  const loggedInMember = await (await second.request.get("/api/status")).json()
  expect(loggedInMember.accountScope).toBe(memberStatus.accountScope)
  await checkApi(second, memberStatus.accountScope, ownerStatus.accountScope, memberLabel, ownerLabel, ownerRun)
  await page.bringToFront()
  await checkUi(page, memberLabel, ownerLabel)

  const deactivate = await control.request.put("/api/accounts", { headers: { Origin: origin }, data: { id: member.id, active: false } })
  expect(deactivate.status()).toBe(200)
  expect((await second.request.get("/api/development-studio/runs")).status()).toBe(401)
  expect((await second.request.get("/api/memory", { headers: { "X-Jarvis-Account-Scope": memberStatus.accountScope } })).status()).toBe(401)
  expect((await (await second.request.get("/api/status")).json()).authenticated).toBe(false)
  expect((await second.request.post("/api/auth", { headers: { Origin: origin }, data: { email, password } })).status()).toBe(401)
  await page.bringToFront()
  await expect(page.getByText(`example/${memberLabel.toLowerCase()}-repo`, { exact: true })).toHaveCount(0, { timeout: 70_000 })
  await page.getByRole("button", { name: "Načíst historii" }).click()
  await expect(page.getByRole("region", { name: "Historie mock průchodů" }).getByRole("alert")).toContainText("Nejste přihlášeni.")
  await page.getByRole("button", { name: "Paměť", exact: true }).click()
  await expect(page.getByText(`${memberLabel} memory`, { exact: true })).toHaveCount(0)
  await control.close()
})
