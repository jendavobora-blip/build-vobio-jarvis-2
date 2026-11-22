import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  use: {
    ...devices["iPhone 13"],
    browserName: "chromium",
    baseURL: "http://127.0.0.1:31848",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : undefined,
  },
  webServer: {
    command: "pnpm start -p 31848",
    url: "http://127.0.0.1:31848/api/status",
    reuseExistingServer: false,
    env: {
      VERCEL_ENV: "preview",
      JARVIS_LIVE_ENABLED: "true",
      JARVIS_ACCESS_CODE: "preview-test-code",
      DEEPSEEK_API_KEY: "preview-test-placeholder",
      DATABASE_URL: "",
    },
  },
})
