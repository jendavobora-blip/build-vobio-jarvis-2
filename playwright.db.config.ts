import { defineConfig, devices } from "@playwright/test"

const database = process.env.JARVIS_TEST_DATABASE_URL
const proxy = process.env.JARVIS_TEST_NEON_PROXY_URL
if (!database || !proxy) throw new Error("Nastavte izolované JARVIS_TEST_DATABASE_URL a JARVIS_TEST_NEON_PROXY_URL.")
const databaseUrl = new URL(database)
const proxyUrl = new URL(proxy)
if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol) || !["localhost", "127.0.0.1"].includes(databaseUrl.hostname) || databaseUrl.pathname !== "/jarvis_test") {
  throw new Error("E2E vyžaduje lokální izolovanou databázi jarvis_test.")
}
if (proxyUrl.protocol !== "http:" || proxyUrl.hostname !== "127.0.0.1" || proxyUrl.pathname !== "/sql") {
  throw new Error("E2E vyžaduje lokální Neon proxy na 127.0.0.1.")
}

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "account-isolation.spec.ts",
  workers: 1,
  use: {
    ...devices["iPhone 13"],
    browserName: "chromium",
    baseURL: "http://localhost:31849",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : undefined,
  },
  webServer: {
    command: "node --require ./tests/e2e/neon-proxy.cjs ./node_modules/next/dist/bin/next start -p 31849",
    url: "http://localhost:31849/api/status",
    reuseExistingServer: false,
    env: {
      DATABASE_URL: database,
      JARVIS_TEST_NEON_PROXY_URL: proxy,
      JARVIS_OWNER_ID: "3a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d",
      JARVIS_ACCESS_CODE: "e2e-owner-code",
      JARVIS_SESSION_SECRET: "e2e-only-session-secret-never-used-outside-tests",
      JARVIS_ENCRYPTION_KEY: "e2e-only-encryption-key-never-used-outside-tests",
      JARVIS_LIVE_ENABLED: "false",
      DEEPSEEK_API_KEY: "",
      VERCEL_ENV: "preview",
    },
  },
})
