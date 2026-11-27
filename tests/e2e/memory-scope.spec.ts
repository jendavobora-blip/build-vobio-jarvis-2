import { expect, test } from "@playwright/test"
import { spawn } from "node:child_process"
import { createHash, createHmac } from "node:crypto"
import { createServer } from "node:net"
import { resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

test("memory API rejects a request bound to a different account", async ({ request }) => {
  const listener = createServer()
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done))
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("Nepodařilo se získat testovací port.")
  const port = address.port
  await new Promise<void>((done, reject) => listener.close((error) => error ? reject(error) : done()))

  const owner = "3a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d"
  const secret = "test-only-session-secret-for-memory-scope"
  const server = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "start", "-p", String(port)], {
    env: { ...process.env, VERCEL_ENV: "preview", DATABASE_URL: "postgres://postgres@127.0.0.1:1/jarvis_test", JARVIS_OWNER_ID: owner, JARVIS_SESSION_SECRET: secret },
    stdio: "ignore",
  })
  const origin = `http://localhost:${port}`
  try {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (server.exitCode !== null) throw new Error("Testovací server se ukončil.")
      try {
        const response = await request.get(`${origin}/api/memory`)
        if (response.status() === 401) {
          ready = true
          break
        }
      } catch {
        await delay(100)
      }
    }
    if (!ready) throw new Error("Testovací server není připraven.")
    const payload = Buffer.from(JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 60, sub: owner, owner, role: "owner", ver: 0, n: "test",
    })).toString("base64url")
    const key = createHash("sha256").update(`sign|${secret}`).digest()
    const signature = createHmac("sha256", key).update(payload).digest("base64url")
    const headers = { Cookie: `jarvis_session=${payload}.${signature}`, Origin: origin, "X-Jarvis-Account-Scope": "stale-account" }
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await request.fetch(`${origin}/api/memory?id=test`, {
        method, headers, ...(method === "PUT" ? { data: {} } : {}),
      })
      expect(response.status(), method).toBe(409)
    }
    const withoutScope = await request.get(`${origin}/api/memory`, { headers: { Cookie: headers.Cookie } })
    expect(withoutScope.status()).toBe(409)
    const scope = createHmac("sha256", secret).update(`status-scope:${owner}:${owner}`).digest("base64url")
    const validScope = await request.get(`${origin}/api/memory`, { headers: { ...headers, "X-Jarvis-Account-Scope": scope } })
    expect(validScope.status()).toBe(503)
  } finally {
    server.kill("SIGTERM")
    await new Promise<void>((done) => server.exitCode !== null ? done() : server.once("exit", () => done()))
  }
})
