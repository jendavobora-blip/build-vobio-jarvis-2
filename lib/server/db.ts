import "server-only"
import { neon } from "@neondatabase/serverless"
import { createHash, randomUUID } from "node:crypto"
import { serverConfig } from "./config"
import { decryptText, encryptText, ownerId } from "./auth"
import type { AgentId, MemoryItem } from "@/lib/jarvis/types"

type Sql = ReturnType<typeof neon>
const OWNER_MIGRATION = "2026-11-stable-owner-v1"

let sqlClient: Sql | undefined
let schemaReady: Promise<void> | undefined

export function installDatabaseAdapterForTesting(client: Sql): void {
  if (process.env.NODE_ENV === "production") throw new Error("Test database adapters are disabled in production.")
  sqlClient = client
  schemaReady = undefined
}

export function clearDatabaseAdapterForTesting(): void {
  if (process.env.NODE_ENV === "production") throw new Error("Test database adapters are disabled in production.")
  sqlClient = undefined
  schemaReady = undefined
}

function getSql(): Sql | undefined {
  if (sqlClient) return sqlClient
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
          IF NOT EXISTS (SELECT 1 FROM jarvis_schema_migrations WHERE version = '2026-11-stable-owner-v1') THEN
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
      requests INTEGER NOT NULL DEFAULT 0,
      reserved_usd DOUBLE PRECISION NOT NULL DEFAULT 0
    )`
    await sql`ALTER TABLE jarvis_usage ADD COLUMN IF NOT EXISTS reserved_usd DOUBLE PRECISION NOT NULL DEFAULT 0`
    await sql`CREATE TABLE IF NOT EXISTS jarvis_budget_reservations (
      id UUID PRIMARY KEY,
      owner_id TEXT NOT NULL,
      day DATE NOT NULL,
      reserved_usd DOUBLE PRECISION NOT NULL CHECK (reserved_usd > 0),
      status TEXT NOT NULL CHECK (status IN ('reserved', 'settled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      settled_at TIMESTAMPTZ
    )`
    await sql`CREATE TABLE IF NOT EXISTS jarvis_rate_limits (
      key TEXT NOT NULL,
      window_start TIMESTAMPTZ NOT NULL,
      count INTEGER NOT NULL CHECK (count > 0),
      PRIMARY KEY (key, window_start)
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
    await sql`CREATE TABLE IF NOT EXISTS jarvis_orchestration_audit (
      id UUID PRIMARY KEY,
      event_key TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL CHECK (agent_id IN ('orchestrator', 'researcher', 'memory', 'planner', 'analyst', 'creator', 'auditor', 'final_judge')),
      event TEXT NOT NULL CHECK (event IN ('run_started', 'run_completed', 'run_failed', 'tool_requested', 'tool_denied', 'tool_succeeded', 'tool_failed')),
      tool_name TEXT,
      failure_reason TEXT CHECK (failure_reason IS NULL OR failure_reason IN ('aborted', 'budget_exceeded', 'model_error', 'tool_error', 'no_result', 'audit_error', 'internal_error')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`
    await sql`ALTER TABLE jarvis_orchestration_audit ADD COLUMN IF NOT EXISTS event_key TEXT`
    await sql`ALTER TABLE jarvis_orchestration_audit ADD COLUMN IF NOT EXISTS failure_reason TEXT`
    await sql`UPDATE jarvis_orchestration_audit SET event_key = id::text WHERE event_key IS NULL`
    await sql`ALTER TABLE jarvis_orchestration_audit ALTER COLUMN event_key SET NOT NULL`
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS jarvis_orchestration_audit_event_key
      ON jarvis_orchestration_audit (event_key)`
    await sql`CREATE INDEX IF NOT EXISTS jarvis_orchestration_audit_owner_actor_created
      ON jarvis_orchestration_audit (owner_id, actor_id, created_at DESC)`
    await sql`CREATE TABLE IF NOT EXISTS jarvis_accounts (
      id UUID PRIMARY KEY,
      owner_id UUID NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      session_version INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (owner_id, email)
    )`
    await sql`ALTER TABLE jarvis_accounts ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0`
    await sql`CREATE TABLE IF NOT EXISTS jarvis_account_invites (
      id UUID PRIMARY KEY,
      owner_id UUID NOT NULL,
      email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      redeemed_at TIMESTAMPTZ,
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

export async function restoreOwnerMemoriesFromBackup(ownerId: string): Promise<number> {
  const sql = await db()
  if (!sql) throw new Error("Databáze není nastavena.")
  const rows = (await sql`WITH restored AS (
    INSERT INTO jarvis_memories (id, owner_id, category, title, content, sensitive, created_at, updated_at)
    SELECT backup.id, ${ownerId}, backup.category, backup.title, backup.content, backup.sensitive, backup.created_at, backup.updated_at
    FROM jarvis_memories_owner_backup backup
    ON CONFLICT (id, owner_id) DO NOTHING
    RETURNING id
  )
  SELECT count(*)::integer AS count FROM restored`) as { count: number }[]
  return Number(rows[0]?.count ?? 0)
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
  const sql = await db()
  if (!sql) {
    const local = memoryLedger.get(today()) ?? { costUsd: 0, tokens: 0, requests: 0 }
    return { ...local, shared: false }
  }
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

export async function reserveDailyBudget(
  ownerId: string,
  reservationId: string,
  amountUsd: number,
  dailyBudgetUsd: number,
): Promise<boolean> {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || !Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd <= 0) {
    throw new Error("Neplatná rezervace rozpočtu.")
  }
  const sql = await db()
  if (!sql) throw new Error("Živý rozpočet vyžaduje sdílenou databázi.")
  const key = today()
  await sql`WITH expired AS (
    UPDATE jarvis_budget_reservations
    SET status = 'settled', settled_at = now()
    WHERE day = ${key} AND status = 'reserved' AND created_at < now() - interval '1 hour'
    RETURNING day, reserved_usd
  ), released AS (
    SELECT day, sum(reserved_usd) AS amount FROM expired GROUP BY day
  )
  UPDATE jarvis_usage usage
  SET reserved_usd = GREATEST(0, usage.reserved_usd - released.amount)
  FROM released
  WHERE usage.day = released.day`
  const rows = (await sql`WITH budget AS (
    INSERT INTO jarvis_usage (day, cost_usd, tokens, requests, reserved_usd)
    VALUES (${key}, 0, 0, 0, ${amountUsd})
    ON CONFLICT (day) DO UPDATE
      SET reserved_usd = jarvis_usage.reserved_usd + EXCLUDED.reserved_usd
      WHERE jarvis_usage.cost_usd + jarvis_usage.reserved_usd + EXCLUDED.reserved_usd <= ${dailyBudgetUsd}
    RETURNING day
  ), reservation AS (
    INSERT INTO jarvis_budget_reservations (id, owner_id, day, reserved_usd, status)
    SELECT ${reservationId}::uuid, ${ownerId}, day, ${amountUsd}, 'reserved' FROM budget
    RETURNING id
  )
  SELECT id FROM reservation`) as { id: string }[]
  return rows.length === 1
}

export async function settleDailyBudget(reservationId: string, costUsd: number, tokens: number): Promise<void> {
  if (!Number.isFinite(costUsd) || costUsd < 0 || !Number.isFinite(tokens) || tokens < 0) {
    throw new Error("Neplatné vyúčtování rozpočtu.")
  }
  const sql = await db()
  if (!sql) throw new Error("Vyúčtování vyžaduje sdílenou databázi.")
  await sql.transaction((tx) => [
    tx`WITH settled AS (
      UPDATE jarvis_budget_reservations
      SET status = 'settled', settled_at = now()
      WHERE id = ${reservationId}::uuid AND status = 'reserved'
      RETURNING day, reserved_usd
    )
    UPDATE jarvis_usage usage
    SET reserved_usd = GREATEST(0, usage.reserved_usd - settled.reserved_usd),
        cost_usd = usage.cost_usd + ${costUsd},
        tokens = usage.tokens + ${Math.trunc(tokens)},
        requests = usage.requests + 1
    FROM settled
    WHERE usage.day = settled.day`,
  ])
}

export async function consumeSharedRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ ok: boolean; retryAfterSec: number }> {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs < 1) {
    throw new Error("Neplatná konfigurace rate limitu.")
  }
  const sql = await db()
  if (!sql) throw new Error("Distribuovaný rate limit vyžaduje sdílenou databázi.")
  const nowMs = Date.now()
  const startMs = Math.floor(nowMs / windowMs) * windowMs
  const windowStart = new Date(startMs).toISOString()
  const rows = (await sql`INSERT INTO jarvis_rate_limits (key, window_start, count)
    VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT (key, window_start) DO UPDATE SET count = jarvis_rate_limits.count + 1
    RETURNING count`) as { count: number }[]
  if (Math.random() < 0.01) {
    await sql`DELETE FROM jarvis_rate_limits WHERE window_start < now() - interval '48 hours'`
  }
  const count = Number(rows[0]?.count ?? limit + 1)
  return {
    ok: count <= limit,
    retryAfterSec: count <= limit ? 0 : Math.max(1, Math.ceil((startMs + windowMs - nowMs) / 1000)),
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

export type OrchestrationAuditEvent =
  | { runId: string; agentId: AgentId; event: "run_started" | "run_completed" }
  | { runId: string; agentId: AgentId; event: "run_failed"; failureReason: OrchestrationFailureReason }
  | { runId: string; agentId: AgentId; event: "tool_requested" | "tool_denied" | "tool_succeeded" | "tool_failed"; toolName: string }

export type OrchestrationFailureReason =
  | "aborted"
  | "budget_exceeded"
  | "model_error"
  | "tool_error"
  | "no_result"
  | "audit_error"
  | "internal_error"

export interface OrchestrationAuditRow {
  run_id: string
  agent_id: AgentId
  event: OrchestrationAuditEvent["event"]
  tool_name: string | null
  failure_reason: OrchestrationFailureReason | null
  actor_id: string
  created_at: string | Date
}

export class OrchestrationAuditError extends Error {
  constructor() {
    super("Uložení auditní události orchestrace selhalo.")
    this.name = "OrchestrationAuditError"
  }
}

export async function recordOrchestrationAuditEvent(
  ownerId: string,
  actorId: string,
  event: OrchestrationAuditEvent,
): Promise<void> {
  if (!ownerId || !actorId || !event.runId) throw new Error("Chybí tenant, uživatel nebo identifikátor orchestrace.")
  const isRunEvent = event.event === "run_started" || event.event === "run_completed" || event.event === "run_failed"
  const toolName = "toolName" in event ? event.toolName.trim().slice(0, 128) : null
  if ("toolName" in event && !toolName) throw new Error("Auditní událost nástroje musí obsahovat název.")
  if (toolName && /[\u0000-\u001f\u007f]/.test(toolName)) throw new Error("Název nástroje obsahuje nepovolené znaky.")
  if (isRunEvent && "toolName" in event) throw new Error("Událost orchestrace nesmí obsahovat název nástroje.")
  const failureReason = event.event === "run_failed" ? event.failureReason : null
  const isTerminal = event.event === "run_completed" || event.event === "run_failed"
  const eventKey = createHash("sha256")
    .update(JSON.stringify([
      ownerId,
      actorId,
      event.runId,
      event.agentId,
      isTerminal ? "run_terminal" : event.event,
      toolName ?? "",
    ]))
    .digest("hex")
  let sql: Sql | undefined
  try {
    sql = await db()
  } catch {
    throw new OrchestrationAuditError()
  }
  if (!sql) throw new OrchestrationAuditError()
  try {
    if (isTerminal) {
      const existing = (await sql`SELECT event FROM jarvis_orchestration_audit
        WHERE owner_id = ${ownerId} AND actor_id = ${actorId} AND run_id = ${event.runId}
          AND event IN ('run_completed', 'run_failed')
        LIMIT 1`) as { event: string }[]
      if (existing[0]) {
        if (existing[0].event !== event.event) throw new OrchestrationAuditError()
        return
      }
    }
    const inserted = (await sql`INSERT INTO jarvis_orchestration_audit
      (id, event_key, owner_id, actor_id, run_id, agent_id, event, tool_name, failure_reason)
      VALUES (${randomUUID()}::uuid, ${eventKey}, ${ownerId}, ${actorId}, ${event.runId},
        ${event.agentId}, ${event.event}, ${toolName}, ${failureReason})
      ON CONFLICT (event_key) DO NOTHING
      RETURNING id`) as { id: string }[]
    if (!inserted.length && isTerminal) {
      const existing = (await sql`SELECT event FROM jarvis_orchestration_audit
        WHERE owner_id = ${ownerId} AND actor_id = ${actorId} AND run_id = ${event.runId}
          AND event IN ('run_completed', 'run_failed')
        LIMIT 1`) as { event: string }[]
      if (existing[0]?.event !== event.event) throw new OrchestrationAuditError()
    }
  } catch (error) {
    if (error instanceof OrchestrationAuditError) throw error
    throw new OrchestrationAuditError()
  }
}

export async function listOrchestrationAudit(
  ownerId: string,
  actorId?: string,
  limit = 100,
): Promise<OrchestrationAuditRow[]> {
  if (!ownerId || (actorId !== undefined && !actorId) || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Neplatný rozsah auditního dotazu.")
  }
  const sql = await db()
  if (!sql) throw new Error("Audit orchestrace vyžaduje sdílenou databázi.")
  if (actorId) {
    return (await sql`SELECT run_id, agent_id, event, tool_name, failure_reason, actor_id, created_at
      FROM jarvis_orchestration_audit
      WHERE owner_id = ${ownerId} AND actor_id = ${actorId}
      ORDER BY created_at DESC LIMIT ${limit}`) as OrchestrationAuditRow[]
  }
  return (await sql`SELECT run_id, agent_id, event, tool_name, failure_reason, actor_id, created_at
    FROM jarvis_orchestration_audit
    WHERE owner_id = ${ownerId}
    ORDER BY created_at DESC LIMIT ${limit}`) as OrchestrationAuditRow[]
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

export async function createAccountInvite(
  ownerId: string,
  email: string,
  id: string,
  tokenHash: string,
): Promise<string> {
  const sql = await db()
  if (!sql) throw new Error("Databáze není nastavena.")
  const rows = (await sql`INSERT INTO jarvis_account_invites (id, owner_id, email, token_hash, expires_at)
    VALUES (${id}, ${ownerId}, ${email}, ${tokenHash}, now() + interval '24 hours')
    RETURNING expires_at`) as { expires_at: string | Date }[]
  if (!rows[0]) throw new Error("Pozvánku nelze vytvořit.")
  return new Date(rows[0].expires_at).toISOString()
}

export async function redeemAccountInvite(
  ownerId: string,
  email: string,
  tokenHash: string,
  userId: string,
  passwordHash: string,
): Promise<string | undefined> {
  const sql = await db()
  if (!sql) throw new Error("Databáze není nastavena.")
  const rows = (await sql`WITH invitation AS (
    UPDATE jarvis_account_invites
    SET redeemed_at = now()
    WHERE owner_id = ${ownerId} AND email = ${email} AND token_hash = ${tokenHash}
      AND redeemed_at IS NULL AND expires_at > now()
      AND NOT EXISTS (SELECT 1 FROM jarvis_accounts WHERE owner_id = ${ownerId} AND email = ${email})
    RETURNING owner_id, email
  ), account AS (
    INSERT INTO jarvis_accounts (id, owner_id, email, password_hash)
    SELECT ${userId}::uuid, owner_id, email, ${passwordHash} FROM invitation
    RETURNING id
  )
  SELECT id FROM account`) as { id: string }[]
  return rows[0]?.id
}

export async function findAccountForLogin(ownerId: string, email: string): Promise<{
  id: string
  password_hash: string
  active: boolean
  session_version: number
} | undefined> {
  const sql = await db()
  if (!sql) throw new Error("Databáze není nastavena.")
  const rows = (await sql`SELECT id, password_hash, active, session_version FROM jarvis_accounts
    WHERE owner_id = ${ownerId} AND email = ${email} LIMIT 1`) as {
    id: string
    password_hash: string
    active: boolean
    session_version: number
  }[]
  return rows[0]
}

export async function isActiveAccount(ownerId: string, userId: string, sessionVersion: number): Promise<boolean> {
  if (ownerId === userId) return true
  const sql = await db()
  if (!sql) return false
  const rows = (await sql`SELECT id FROM jarvis_accounts
    WHERE owner_id = ${ownerId} AND id = ${userId} AND active = TRUE AND session_version = ${sessionVersion} LIMIT 1`) as { id: string }[]
  return rows.length > 0
}

export async function listAccounts(ownerId: string): Promise<{ id: string; email: string; active: boolean; created_at: string | Date }[]> {
  const sql = await db()
  if (!sql) throw new Error("Databáze není nastavena.")
  return (await sql`SELECT id, email, active, created_at FROM jarvis_accounts
    WHERE owner_id = ${ownerId} ORDER BY created_at DESC LIMIT 200`) as {
    id: string
    email: string
    active: boolean
    created_at: string | Date
  }[]
}

export async function setAccountActive(ownerId: string, userId: string, active: boolean): Promise<boolean> {
  const sql = await db()
  if (!sql) throw new Error("Databáze není nastavena.")
  const rows = (await sql`UPDATE jarvis_accounts
    SET session_version = session_version + CASE WHEN active IS DISTINCT FROM ${active} THEN 1 ELSE 0 END,
        active = ${active}
    WHERE owner_id = ${ownerId} AND id = ${userId} RETURNING id`) as { id: string }[]
  return rows.length === 1
}
