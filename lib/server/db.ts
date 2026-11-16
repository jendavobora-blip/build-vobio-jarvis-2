import "server-only"
import { neon } from "@neondatabase/serverless"
import { serverConfig } from "./config"
import { decryptText, encryptText } from "./auth"
import type { MemoryItem } from "@/lib/jarvis/types"

type Sql = ReturnType<typeof neon>

let sqlClient: Sql | undefined
let schemaReady: Promise<void> | undefined

function getSql(): Sql | undefined {
  const url = serverConfig.databaseUrl
  if (!url) return undefined
  sqlClient ??= neon(url)
  return sqlClient
}

export function isDatabaseConfigured(): boolean {
  return Boolean(serverConfig.databaseUrl)
}

async function ensureSchema(sql: Sql) {
  schemaReady ??= (async () => {
    await sql`CREATE TABLE IF NOT EXISTS jarvis_memories (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      sensitive BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`
    await sql`CREATE TABLE IF NOT EXISTS jarvis_usage (
      day DATE PRIMARY KEY,
      cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      tokens BIGINT NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0
    )`
  })().catch((error) => {
    schemaReady = undefined
    throw error
  })
  await schemaReady
}

async function db(): Promise<Sql | undefined> {
  const sql = getSql()
  if (!sql) return undefined
  await ensureSchema(sql)
  return sql
}

interface MemoryRow {
  id: string
  category: MemoryItem["category"]
  title: string
  content: string
  sensitive: boolean
  created_at: string | Date
  updated_at: string | Date
}

function toItem(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    content: row.sensitive ? decryptText(row.content) : row.content,
    sensitive: row.sensitive,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export async function listMemories(): Promise<MemoryItem[]> {
  const sql = await db()
  if (!sql) return []
  const rows = (await sql`SELECT * FROM jarvis_memories ORDER BY updated_at DESC LIMIT 500`) as MemoryRow[]
  return rows.map(toItem)
}

export async function upsertMemory(item: MemoryItem): Promise<void> {
  const sql = await db()
  if (!sql) throw new Error("Databáze není nastavena.")
  const content = item.sensitive ? encryptText(item.content) : item.content
  await sql`INSERT INTO jarvis_memories (id, category, title, content, sensitive, created_at, updated_at)
    VALUES (${item.id}, ${item.category}, ${item.title}, ${content}, ${item.sensitive}, ${item.createdAt}, ${item.updatedAt})
    ON CONFLICT (id) DO UPDATE SET category = EXCLUDED.category, title = EXCLUDED.title,
      content = EXCLUDED.content, sensitive = EXCLUDED.sensitive, updated_at = EXCLUDED.updated_at`
}

export async function deleteMemory(id: string): Promise<void> {
  const sql = await db()
  if (!sql) throw new Error("Databáze není nastavena.")
  await sql`DELETE FROM jarvis_memories WHERE id = ${id}`
}

/* ---------- Daily spend ledger ---------- */

const memoryLedger = new Map<string, { costUsd: number; tokens: number; requests: number }>()

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function getDailyUsage(): Promise<{ costUsd: number; tokens: number; requests: number; shared: boolean }> {
  try {
    const sql = await db()
    if (sql) {
      const rows = (await sql`SELECT cost_usd, tokens, requests FROM jarvis_usage WHERE day = ${today()}`) as {
        cost_usd: number
        tokens: string | number
        requests: number
      }[]
      const row = rows[0]
      return {
        costUsd: Number(row?.cost_usd ?? 0),
        tokens: Number(row?.tokens ?? 0),
        requests: Number(row?.requests ?? 0),
        shared: true,
      }
    }
  } catch (error) {
    console.error("[jarvis] usage ledger read failed", error instanceof Error ? error.message : error)
  }
  const local = memoryLedger.get(today()) ?? { costUsd: 0, tokens: 0, requests: 0 }
  return { ...local, shared: false }
}

export async function recordUsage(costUsd: number, tokens: number): Promise<void> {
  const key = today()
  const local = memoryLedger.get(key) ?? { costUsd: 0, tokens: 0, requests: 0 }
  memoryLedger.set(key, { costUsd: local.costUsd + costUsd, tokens: local.tokens + tokens, requests: local.requests + 1 })
  try {
    const sql = await db()
    if (!sql) return
    await sql`INSERT INTO jarvis_usage (day, cost_usd, tokens, requests) VALUES (${key}, ${costUsd}, ${tokens}, 1)
      ON CONFLICT (day) DO UPDATE SET cost_usd = jarvis_usage.cost_usd + EXCLUDED.cost_usd,
        tokens = jarvis_usage.tokens + EXCLUDED.tokens, requests = jarvis_usage.requests + 1`
  } catch (error) {
    console.error("[jarvis] usage ledger write failed", error instanceof Error ? error.message : error)
  }
}
