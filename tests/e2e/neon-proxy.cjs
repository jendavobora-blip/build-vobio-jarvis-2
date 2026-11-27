const proxy = new URL(process.env.JARVIS_TEST_NEON_PROXY_URL)
if (proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1" || proxy.pathname !== "/sql") {
  throw new Error("Neplatná lokální testovací Neon proxy.")
}
const originalFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input.url
  if (url === "https://localhost/sql" || url === "https://api.0.0.1/sql") {
    return originalFetch(proxy, init)
  }
  return originalFetch(input, init)
}
