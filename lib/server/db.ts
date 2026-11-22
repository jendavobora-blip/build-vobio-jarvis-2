import "server-only"
import { neon } from "@neondatabase/serverless"
import { randomUUID } from "node:crypto"
import { serverConfig } from "./config"
import { decryptText, encryptText, ownerId } from "./auth"
import type { MemoryItem } from "@/lib/jarvis/types"

type Sql = ReturnType<typeof neon>
const OWNER_MIGRATION = "2026-11-stable-owner-v1"

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
    const stableOwnerId = ownerId()
    if (!stableOwnerId) throw new Error("Nastavte stabilní JARVIS_OWNER_ID před přístupem k databázi.")
    await sql`CREATE TABLE IF NOT EXISTS jarvis_memories (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT 'legacy-owner',
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      sensitive BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`
    await sql`ALTER TABLE jarvis_memories ADD COLUMN IF NOT EXISTS owner_id TEXT`
    await sql`CREATE TABLE IF NOT EXISTS jarvis_schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`
    await sql`CREATE TABLE IF NOT EXISTS jarvis_memories_owner_backup (
      id TEXT PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      sensitive BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
    )`
    await sql.transaction((tx) => [
      tx`INSERT INTO jarvis_memories_owner_backup (id, category, title, content, sensitive, created_at, updated_at)
        SELECT id, category, title, content, sensitive, created_at, updated_at FROM jarvis_memories
        WHERE NOT EXISTS (SELECT 1 FROM jarvis_schema_migrations WHERE version = ${OWNER_MIGRATION})
        ON CONFLICT (id) DO NOTHING`,
      tx`UPDATE jarvis_memories SET owner_id = ${stableOwnerId}
        WHERE NOT EXISTS (SELECT 1 FROM jarvis_schema_migrations WHERE version = ${OWNER_MIGRATION})`,
      tx`DO $migration$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM jarvis_schema_migrations WHERE version = '${OWNER_MIGRATION}') THEN
            ALTER TABLE jarvis_memories DROP CONSTRAINT IF EXISTS jarvis_memories_pkey;
            ALTER TABLE jarvis_memories ADD PRIMARY KEY (id, owner_id);
          END IF;
        END
        $migration$`,
      tx`INSERT INTO jarvis_schema_migrations (version) VALUES (${OWNER_MIGRATION}) ON CONFLICT (version) DO NOTHING`,
    ])
    await sql`CREATE TABLE IF NOT EXISTS jarvis_usage (
      day DATE PRIMARY KEY,
      cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      tokens BIGINT NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0
    )`
    await sql`CREATE TABLE IF NOT EXISTS jarvis_approvals (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'critical_reviewed', 'approved', 'denied', 'executed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ
    )`
    await sql`DO $approval_status$
      DECLARE constraint_definition TEXT;
      BEGIN
        SELECT pg_get_constraintdef(oid) INTO constraint_definition
          FROM pg_constraint WHERE conname = 'jarvis_approvals_status_check'
            AND conrelid = 'jarvis_approvals'::regclass;
        IF constraint_definition IS NULL THEN
          ALTER TABLE jarvis_approvals ADD CONSTRAINT jarvis_approvals_status_check
            CHECK (status IN ('pending', 'critical_reviewed', 'approved', 'denied', 'executed'));
        ELSIF position('critical_reviewed' in constraint_definition) = 0 THEN
          ALTER TABLE jarvis_approvals DROP CONSTRAINT jarvis_approvals_status_check;
          ALTER TABLE jarvis_approvals ADD CONSTRAINT jarvis_approvals_status_check
            CHECK (status IN ('pending', 'critical_reviewed', 'approved', 'denied', 'executed'));
        END IF;
      END
      $approval_status$`
    await sql`CREATE TABLE IF NOT EXISTS jarvis_approval_audit (
      id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      event TEXT NOT NULL CHECK (event IN ('created', 'critical_reviewed', 'approved', 'denied', 'execution_authorized')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

export async function listMemories(ownerId: string): Promise<MemoryItem[]> {
  const sql = await db()
  if (!sql) return []
  const rows = (await sql`SELECT * FROM jarvis_memories WHERE owner_id = ${ownerId} ORDER BY updated_at DESC LIMIT 500`) as MemoryRow[]
  return rows.map(toItem)
}

export async function upsertMemory(ownerId: string, item: MemoryItem): Promise<void> {
  const sql = await db()
  if (!sql) throw new Error("Databáze není nastavena.")
  const content = item.sensitive ? encryptText(item.content) : item.content
  await sql`INSERT INTO jarvis_memories (id, owner_id, category, title, content, sensitive, created_at, updated_at)
    VALUES (${item.id}, ${ownerId}, ${item.category}, ${item.title}, ${content}, ${item.sensitive}, ${item.createdAt}, ${item.updatedAt})
    ON CONFLICT (id, owner_id) DO UPDATE SET category = EXCLUDED.category, title = EXCLUDED.title,
      content = EXCLUDED.content, sensitive = EXCLUDED.sensitive, updated_at = EXCLUDED.updated_at`
}

export async function deleteMemory(ownerId: string, id: string): Promise<void> {
  const sql = await db()
  if (!sql) throw new Error("Databáze není nastavena.")
  await sql`DELETE FROM jarvis_memories WHERE owner_id = ${ownerId} AND id = ${id}`
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

export interface ApprovalRow {
  id: string
  owner_id: string
  plan_hash: string
  plan_json: string
  status: "pending" | "critical_reviewed" | "approved" | "denied" | "executed"
  created_at: string | Date
  resolved_at: string | Date | null
}

export async function createApproval(ownerId: string, id: string, planHash: string, planJson: string): Promise<ApprovalRow> {
  const sql = await db()
  if (!sql) throw new Error("Databáze není nastavena.")
  const rows = (await sql`WITH created AS (
    INSERT INTO jarvis_approvals (id, owner_id, plan_hash, plan_json, status)
    VALUES (${id}, ${ownerId}, ${planHash}, ${planJson}, 'pending')
    ON CONFLICT (id) DO NOTHING
    RETURNING *
  ), logged AS (
    INSERT INTO jarvis_approval_audit (id, approval_id, owner_id, plan_hash, event)
    SELECT ${randomUUID()}, id, owner_id, plan_hash, 'created' FROM created
    RETURNING approval_id
  )
  SELECT created.* FROM created JOIN logged ON logged.approval_id = created.id`) as ApprovalRow[]
  if (!rows[0]) {
    const existing = (await sql`SELECT * FROM jarvis_approvals WHERE id = ${id} AND owner_id = ${ownerId} LIMIT 1`) as ApprovalRow[]
    if (!existing[0]) throw new Error("Schvalování náleží jinému uživateli.")
    if (existing[0].plan_hash !== planHash) throw new Error("Akce byla změněna a musí být předložena jako nový plán.")
    return existing[0]
  }
  return rows[0]
}

export async function resolveApproval(
  ownerId: string,
  id: string,
  planHash: string,
  status: "approve" | "confirm_critical" | "deny",
): Promise<ApprovalRow | undefined> {
  const sql = await db()
  if (!sql) throw new Error("Databáze není nastavena.")
  const rows = (await sql`WITH changed AS (
    UPDATE jarvis_approvals
    SET status = CASE
          WHEN ${status} = 'deny' THEN 'denied'
          WHEN ${status} = 'confirm_critical' THEN 'approved'
          WHEN (plan_json::jsonb->>'critical')::boolean THEN 'critical_reviewed'
          ELSE 'approved'
        END,
        resolved_at = CASE
          WHEN ${status} = 'approve' AND (plan_json::jsonb->>'critical')::boolean THEN NULL
          ELSE now()
        END
    WHERE id = ${id} AND owner_id = ${ownerId} AND plan_hash = ${planHash}
      AND (
        (${status} = 'approve' AND status = 'pending')
        OR (${status} = 'confirm_critical' AND status = 'critical_reviewed' AND (plan_json::jsonb->>'critical')::boolean)
        OR (${status} = 'deny' AND status IN ('pending', 'critical_reviewed'))
      )
    RETURNING *
  ), logged AS (
    INSERT INTO jarvis_approval_audit (id, approval_id, owner_id, plan_hash, event)
    SELECT ${randomUUID()}, id, owner_id, plan_hash,
      CASE WHEN status = 'critical_reviewed' THEN 'critical_reviewed'
        WHEN status = 'denied' THEN 'denied' ELSE 'approved' END
    FROM changed
    RETURNING approval_id
  )
  SELECT changed.* FROM changed JOIN logged ON logged.approval_id = changed.id`) as ApprovalRow[]
  return rows[0]
}

export async function listApprovals(ownerId: string): Promise<ApprovalRow[]> {
  const sql = await db()
  if (!sql) return []
  return (await sql`SELECT * FROM jarvis_approvals WHERE owner_id = ${ownerId} ORDER BY created_at DESC LIMIT 200`) as ApprovalRow[]
}

export async function listApprovalAudit(ownerId: string): Promise<{ approval_id: string; plan_hash: string; event: string; created_at: string | Date }[]> {
  const sql = await db()
  if (!sql) return []
  return (await sql`SELECT approval_id, plan_hash, event, created_at FROM jarvis_approval_audit
    WHERE owner_id = ${ownerId} ORDER BY created_at DESC LIMIT 500`) as {
    approval_id: string
    plan_hash: string
    event: string
    created_at: string | Date
  }[]
}

export async function consumeApproval(ownerId: string, id: string, planHash: string): Promise<string | undefined> {
  const sql = await db()
  if (!sql) throw new Error("Databáze není nastavena.")
  const rows = (await sql`WITH consumed AS (
    UPDATE jarvis_approvals
    SET status = 'executed', resolved_at = now()
    WHERE id = ${id} AND owner_id = ${ownerId} AND plan_hash = ${planHash} AND status = 'approved'
    RETURNING *
  ), logged AS (
    INSERT INTO jarvis_approval_audit (id, approval_id, owner_id, plan_hash, event)
    SELECT ${randomUUID()}, id, owner_id, plan_hash, 'execution_authorized' FROM consumed
    RETURNING approval_id
  )
  SELECT consumed.plan_json FROM consumed JOIN logged ON logged.approval_id = consumed.id`) as { plan_json: string }[]
  return rows[0]?.plan_json
}
