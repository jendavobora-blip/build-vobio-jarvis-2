import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { Pool, type PoolClient } from "pg"
import {
  clearDatabaseAdapterForTesting,
  consumeSharedRateLimit,
  createAccountInvite,
  findAccountForLogin,
  getDailyUsage,
  installDatabaseAdapterForTesting,
  isActiveAccount,
  listDevelopmentStudioEvents,
  listDevelopmentStudioRuns,
  listMemories,
  listOrchestrationAudit,
  persistDevelopmentStudioMockRun,
  recordOrchestrationAuditEvent,
  redeemAccountInvite,
  reserveDailyBudget,
  restoreOwnerMemoriesFromBackup,
  settleDailyBudget,
  setAccountActive,
  upsertMemory,
} from "../lib/server/db"
import { encryptText } from "../lib/server/auth"
import { preserveUsageForSettlement, settleBudgetUsage } from "../lib/server/usage-settlement"
import { createMockDevelopmentStudioRun } from "../lib/jarvis/development-studio"

const connectionString = process.env.JARVIS_TEST_DATABASE_URL
if (!connectionString) throw new Error("Nastavte JARVIS_TEST_DATABASE_URL na izolovaný testovací PostgreSQL.")

const parsedUrl = new URL(connectionString)
assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsedUrl.hostname), "DB testy smí běžet jen proti loopback hostu.")
assert.equal(parsedUrl.pathname, "/jarvis_test", "DB testy vyžadují databázi jarvis_test.")

const pool = new Pool({ connectionString })
const owner = "3a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d"
const member = "4b4c5d6e-7f80-4b9c-8d1e-2f3a4b5c6d7e"

function statement(strings: TemplateStringsArray, values: readonly unknown[]): { text: string; values: unknown[] } {
  let text = strings[0] ?? ""
  for (let index = 0; index < values.length; index += 1) {
    text += `$${index + 1}${strings[index + 1] ?? ""}`
  }
  return { text, values: [...values] }
}

function createPostgresAdapter(client: Pool | PoolClient) {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = statement(strings, values)
    return client.query(query.text, query.values).then((result) => result.rows)
  }) as ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) & {
    transaction: (fn: (tx: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>) => Promise<unknown[]>[]) => Promise<unknown[][]>
  }

  tag.transaction = async (fn) => {
    const transactionClient = await pool.connect()
    const pending: Promise<unknown[]>[] = []
    let tail: Promise<unknown> = Promise.resolve()
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = statement(strings, values)
      const result = tail.then(async () => (await transactionClient.query(query.text, query.values)).rows)
      tail = result
      pending.push(result)
      return result
    }) as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>
    try {
      await transactionClient.query("BEGIN")
      const results = fn(tx)
      const resolved = await Promise.all(results)
      await tail
      await transactionClient.query("COMMIT")
      return resolved
    } catch (error) {
      await transactionClient.query("ROLLBACK")
      throw error
    } finally {
      transactionClient.release()
    }
  }
  return tag
}

const adapter = createPostgresAdapter(pool)
installDatabaseAdapterForTesting(adapter as unknown as Parameters<typeof installDatabaseAdapterForTesting>[0])

process.env.DATABASE_URL = connectionString
process.env.JARVIS_OWNER_ID = owner
process.env.JARVIS_ENCRYPTION_KEY = "postgres-integration-test-encryption-key"

after(async () => {
  clearDatabaseAdapterForTesting()
  await pool.end()
})

test("PostgreSQL migrates legacy memory, retains a recovery snapshot, and isolates member rows", async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public")
  await pool.query(`CREATE TABLE jarvis_memories (
    id TEXT PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    sensitive BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
  )`)
  await pool.query(`CREATE TABLE jarvis_accounts (
    id UUID PRIMARY KEY, owner_id UUID NOT NULL, email TEXT NOT NULL, password_hash TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (owner_id, email)
  )`)
  const legacyCiphertext = encryptText("starší soukromá poznámka")
  await pool.query(
    `INSERT INTO jarvis_memories (id, category, title, content, sensitive, created_at, updated_at)
     VALUES ($1, 'history', 'Legacy', $2, TRUE, now(), now())`,
    ["legacy-memory", legacyCiphertext],
  )

  const ownerItems = await listMemories(owner)
  assert.equal(ownerItems.length, 1)
  assert.equal(ownerItems[0]?.content, "starší soukromá poznámka")
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM jarvis_memories_owner_backup")).rows[0]?.count, 1)
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM jarvis_schema_migrations")).rows[0]?.count, 1)
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name = 'jarvis_accounts' AND column_name = 'session_version'")).rows[0]?.count,
    1,
  )

  installDatabaseAdapterForTesting(adapter as unknown as Parameters<typeof installDatabaseAdapterForTesting>[0])
  await listMemories(owner)
  await pool.query("DELETE FROM jarvis_memories WHERE id = $1 AND owner_id = $2", ["legacy-memory", owner])
  assert.equal(await restoreOwnerMemoriesFromBackup(owner), 1)
  assert.equal(await restoreOwnerMemoriesFromBackup(owner), 0)

  await upsertMemory(member, {
    id: "member-memory",
    category: "history",
    title: "Členská položka",
    content: "Oddělený obsah",
    sensitive: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  assert.deepEqual((await listMemories(owner)).map((item) => item.id), ["legacy-memory"])
  assert.deepEqual((await listMemories(member)).map((item) => item.id), ["member-memory"])
})

test("PostgreSQL invitations are single-use and tenant-scoped", async () => {
  const invitationId = randomUUID()
  const tokenHash = createHash("sha256").update("one-time-test-token").digest("base64url")
  await createAccountInvite(owner, "member@example.test", invitationId, tokenHash)
  const accountId = await redeemAccountInvite(owner, "member@example.test", tokenHash, member, "scrypt-test-hash")
  assert.equal(accountId, member)
  assert.equal(await redeemAccountInvite(owner, "member@example.test", tokenHash, randomUUID(), "unused"), undefined)
  assert.equal(await findAccountForLogin(owner, "member@example.test")?.then((account) => account?.id), member)
  assert.equal(await findAccountForLogin("5c5d6e7f-8091-4cad-9e2f-3a4b5c6d7e8f", "member@example.test")?.then((account) => account?.id), undefined)

  assert.equal(await isActiveAccount(owner, member, 0), true)
  assert.equal(await setAccountActive(owner, member, false), true)
  assert.equal(await isActiveAccount(owner, member, 0), false)
  assert.equal(await setAccountActive(owner, member, true), true)
  const reactivatedAccount = await findAccountForLogin(owner, "member@example.test")
  assert.equal(reactivatedAccount?.session_version, 2)
  assert.equal(await isActiveAccount(owner, member, 0), false)
  assert.equal(await isActiveAccount(owner, member, 2), true)

  const expiringId = randomUUID()
  const expiringHash = createHash("sha256").update("expired-test-token").digest("base64url")
  await createAccountInvite(owner, "expired@example.test", expiringId, expiringHash)
  await pool.query("UPDATE jarvis_account_invites SET expires_at = now() - interval '1 second' WHERE id = $1", [expiringId])
  assert.equal(await redeemAccountInvite(owner, "expired@example.test", expiringHash, randomUUID(), "unused"), undefined)
})

test("PostgreSQL orchestration audit is append-only, tenant-scoped, and omits prompt data", async () => {
  const runId = randomUUID()
  await recordOrchestrationAuditEvent(owner, member, {
    runId,
    agentId: "orchestrator",
    event: "run_started",
  })
  await recordOrchestrationAuditEvent(owner, member, {
    runId,
    agentId: "memory",
    event: "tool_requested",
    toolName: "search_memory",
  })
  await recordOrchestrationAuditEvent(owner, member, {
    runId,
    agentId: "memory",
    event: "tool_succeeded",
    toolName: "search_memory",
  })
  await recordOrchestrationAuditEvent(owner, member, {
    runId,
    agentId: "orchestrator",
    event: "run_completed",
  })
  await recordOrchestrationAuditEvent("5c5d6e7f-8091-4cad-9e2f-3a4b5c6d7e8f", member, {
    runId: randomUUID(),
    agentId: "orchestrator",
    event: "run_started",
  })

  const tenantEvents = await listOrchestrationAudit(owner)
  const memberEvents = await listOrchestrationAudit(owner, member)
  assert.deepEqual(tenantEvents.map((event) => event.event).sort(), ["run_started", "tool_requested", "tool_succeeded", "run_completed"].sort())
  assert.deepEqual(memberEvents.map((event) => event.event).sort(), ["run_started", "tool_requested", "tool_succeeded", "run_completed"].sort())
  assert.ok(tenantEvents.every((event) => event.run_id === runId))
  assert.ok(tenantEvents.every((event) => !("prompt" in event) && !("arguments" in event)))
  assert.equal((await listOrchestrationAudit(owner, "another-member")).length, 0)
  assert.equal((await listOrchestrationAudit("5c5d6e7f-8091-4cad-9e2f-3a4b5c6d7e8f")).length, 1)
})

test("PostgreSQL orchestration audit deduplicates concurrent events and preserves one terminal status", async () => {
  const runId = randomUUID()
  await recordOrchestrationAuditEvent(owner, member, {
    runId,
    agentId: "orchestrator",
    event: "run_started",
  })

  await Promise.all(
    Array.from({ length: 24 }, () =>
      recordOrchestrationAuditEvent(owner, member, {
        runId,
        agentId: "orchestrator",
        event: "run_failed",
        failureReason: "budget_exceeded",
      }),
    ),
  )

  const rows = await pool.query(
    "SELECT event, failure_reason FROM jarvis_orchestration_audit WHERE owner_id = $1 AND actor_id = $2 AND run_id = $3",
    [owner, member, runId],
  )
  assert.equal(rows.rows.filter((row) => row.event === "run_failed").length, 1)
  assert.equal(rows.rows.find((row) => row.event === "run_failed")?.failure_reason, "budget_exceeded")
  await assert.rejects(
    recordOrchestrationAuditEvent(owner, member, {
      runId,
      agentId: "orchestrator",
      event: "run_completed",
    }),
    /Uložení auditní události/,
  )
})

test("PostgreSQL audit writer reports database failures instead of succeeding silently", async () => {
  const unavailable = (async () => {
    throw new Error("simulated PostgreSQL outage")
  }) as unknown as Parameters<typeof installDatabaseAdapterForTesting>[0]
  installDatabaseAdapterForTesting(unavailable)
  try {
    await assert.rejects(
      recordOrchestrationAuditEvent(owner, member, {
        runId: randomUUID(),
        agentId: "orchestrator",
        event: "run_started",
      }),
      /Uložení auditní události orchestrace selhalo/,
    )
  } finally {
    installDatabaseAdapterForTesting(adapter as unknown as Parameters<typeof installDatabaseAdapterForTesting>[0])
  }
})

test("PostgreSQL rate limits and daily budget reservations are atomic under concurrency", async () => {
  const rateResults = await Promise.all(
    Array.from({ length: 20 }, () => consumeSharedRateLimit("same-test-client", 5, 60_000)),
  )
  assert.equal(rateResults.filter((result) => result.ok).length, 5)

  const reservations = await Promise.all(
    Array.from({ length: 5 }, async () => {
      const id = randomUUID()
      return { id, accepted: await reserveDailyBudget(owner, id, 0.02, 0.05) }
    }),
  )
  const accepted = reservations.filter((entry) => entry.accepted)
  assert.equal(accepted.length, 2)
  await settleDailyBudget(accepted[0]!.id, 0.01, 50)
  await settleDailyBudget(accepted[0]!.id, 0.01, 50)
  const usage = await getDailyUsage()
  assert.equal(usage.costUsd, 0.01)
  assert.equal(usage.requests, 1)
  const afterSettlement = await reserveDailyBudget(owner, randomUUID(), 0.01, 0.05)
  assert.equal(afterSettlement, true)
  await pool.query(
    "UPDATE jarvis_budget_reservations SET created_at = now() - interval '2 hours' WHERE status = 'reserved' AND reserved_usd = 0.02",
  )
  const recovered = await reserveDailyBudget(owner, randomUUID(), 0.01, 0.05)
  assert.equal(recovered, true)
  assert.ok(Math.abs((await getDailyUsage()).costUsd - 0.03) < 1e-9)
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM jarvis_budget_reservations WHERE status = 'reserved' AND created_at < now() - interval '1 hour'")).rows[0]?.count,
    0,
  )
})

test("PostgreSQL settlement preserves actual cost and tokens when audit persistence fails", async () => {
  const before = await getDailyUsage()
  const reservationId = randomUUID()
  assert.equal(await reserveDailyBudget(owner, reservationId, 0.02, 1), true)
  const auditFailure = Object.assign(new Error("simulated audit database outage"), {
    usage: { costUsd: 0.0075, promptTokens: 140, completionTokens: 35 },
  })
  const usage = preserveUsageForSettlement({ costUsd: 0, tokens: 0, usageKnown: false }, auditFailure)

  await settleBudgetUsage(reservationId, usage, settleDailyBudget)
  const after = await getDailyUsage()

  assert.ok(after.costUsd - before.costUsd >= usage.costUsd - 1e-9)
  assert.equal(after.tokens - before.tokens, 175)
  const reservation = await pool.query("SELECT status FROM jarvis_budget_reservations WHERE id = $1", [reservationId])
  assert.equal(reservation.rows[0]?.status, "settled")
})

test("PostgreSQL unknown usage conservatively accounts the reservation instead of releasing it free", async () => {
  const before = await getDailyUsage()
  const reservationId = randomUUID()
  assert.equal(await reserveDailyBudget(owner, reservationId, 0.02, 1), true)
  await settleDailyBudget(reservationId, 0, 0, false)
  const reservation = await pool.query(
    "SELECT status, reserved_usd, usage_uncertain FROM jarvis_budget_reservations WHERE id = $1",
    [reservationId],
  )
  assert.equal(reservation.rows[0]?.status, "settled")
  assert.equal(Number(reservation.rows[0]?.reserved_usd), 0.02)
  assert.equal(reservation.rows[0]?.usage_uncertain, true)
  assert.ok(Math.abs((await getDailyUsage()).costUsd - before.costUsd - 0.02) < 1e-9)
})

test("PostgreSQL stores mock Studio events atomically and isolates tenant and user history", async () => {
  const task = "Add a safe development history"
  const createRun = (id: string) => createMockDevelopmentStudioRun({
    id,
    repository: "octocat/hello-world",
    task,
    taskHash: createHash("sha256").update(task).digest("hex"),
  })
  const ownerRun = await createRun(randomUUID())
  const memberRun = await createRun(randomUUID())
  await persistDevelopmentStudioMockRun(owner, owner, ownerRun)
  await assert.rejects(persistDevelopmentStudioMockRun(owner, owner, ownerRun))
  await persistDevelopmentStudioMockRun(owner, member, memberRun)

  const ownerHistory = await listDevelopmentStudioRuns(owner, owner)
  const memberHistory = await listDevelopmentStudioRuns(owner, member)
  assert.deepEqual(ownerHistory.map((run) => run.id), [ownerRun.id])
  assert.deepEqual(memberHistory.map((run) => run.id), [memberRun.id])
  assert.deepEqual(await listDevelopmentStudioRuns(member, member), [])
  assert.equal((await listDevelopmentStudioEvents(owner, owner, ownerRun.id)).length, 19)
  assert.deepEqual(await listDevelopmentStudioEvents(member, member, ownerRun.id), [])
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM jarvis_development_studio_events WHERE run_id = $1", [ownerRun.id])).rows[0]?.count,
    19,
  )
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM jarvis_development_studio_runs WHERE task_hash = $1", [ownerRun.taskHash])).rows[0]?.count,
    2,
  )
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name = 'jarvis_development_studio_runs' AND column_name = 'task'")).rows[0]?.count,
    0,
  )
})
