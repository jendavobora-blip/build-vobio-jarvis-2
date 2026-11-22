import { expect, test } from "@playwright/test"

test("preview rejects live AI calls even when the flag and credentials are configured", async ({ request }) => {
  const status = await request.get("/api/status")
  expect(status.ok()).toBeTruthy()
  expect((await status.json()).liveEnabled).toBe(false)
  const chat = await request.post("/api/chat", { data: {} })
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
  const card = page.getByRole("button", { name: /Orchestrátor:.*Otevřít detail/ })
  await expect(card).toBeVisible()
  await card.click()
  await expect(page.getByRole("dialog", { name: "Orchestrátor" })).toBeVisible()
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
  await expect(page.getByRole("dialog", { name: "Orchestrátor" })).toBeVisible()
  await page.getByRole("button", { name: "Zavřít", exact: true }).click()
  await canvas.evaluate((element) => element.dispatchEvent(new Event("webglcontextlost", { cancelable: true })))
  await expect(status).toContainText("3D není dostupné")
  await expect(page.getByRole("button", { name: /Orchestrátor:.*Otevřít detail/ })).toBeVisible()
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
