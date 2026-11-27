import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { Pool, type PoolClient } from "pg"
import {
  clearDatabaseAdapterForTesting,
  consumeApproval,
  consumeSharedRateLimit,
  createAccountInvite,
  createApproval,
  DevelopmentStudioIdempotencyConflictError,
  findAccountForLogin,
  getDailyUsage,
  installDatabaseAdapterForTesting,
  isActiveAccount,
  listDevelopmentStudioEvents,
  listDevelopmentStudioRuns,
  listMemories,
  listApprovalAudit,
  listOrchestrationAudit,
  persistDevelopmentStudioMockRun,
  recordOrchestrationAuditEvent,
  redeemAccountInvite,
  reserveDailyBudget,
  resolveApproval,
  restoreOwnerMemoriesFromBackup,
  settleDailyBudget,
  setAccountActive,
  upsertMemory,
} from "../lib/server/db"
import { decryptText, encryptText } from "../lib/server/auth"
import { approvalHash } from "../lib/server/approvals"
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
const rotationOwner = "6d7e8f90-a1b2-4c3d-8e9f-0a1b2c3d4e5f"
const rotationTable = "jarvis_test_reencryption_records"
const oldTestKey = "old-test-key-for-reencryption-1234567890"
const newTestKey = "new-test-key-for-reencryption-1234567890"
const decryptionFailure = "[nelze dešifrovat – ověřte JARVIS_ENCRYPTION_KEY a případný JARVIS_LEGACY_ENCRYPTION_KEY]"
let rotationTableCreated = false

interface RotationRecord {
  id: string
  owner_id: string
  category: string
  title: string
  content: string
  sensitive: boolean
  created_at: Date
  updated_at: Date
}

function withEncryptionKeys<T>(current: string, legacy: string | undefined, callback: () => T): T {
  const previousCurrent = process.env.JARVIS_ENCRYPTION_KEY
  const previousLegacy = process.env.JARVIS_LEGACY_ENCRYPTION_KEY
  process.env.JARVIS_ENCRYPTION_KEY = current
  if (legacy === undefined) delete process.env.JARVIS_LEGACY_ENCRYPTION_KEY
  else process.env.JARVIS_LEGACY_ENCRYPTION_KEY = legacy
  try {
    return callback()
  } finally {
    if (previousCurrent === undefined) delete process.env.JARVIS_ENCRYPTION_KEY
    else process.env.JARVIS_ENCRYPTION_KEY = previousCurrent
    if (previousLegacy === undefined) delete process.env.JARVIS_LEGACY_ENCRYPTION_KEY
    else process.env.JARVIS_LEGACY_ENCRYPTION_KEY = previousLegacy
  }
}

function decryptWithKey(ciphertext: string, key: string): string {
  return withEncryptionKeys(key, undefined, () => decryptText(ciphertext))
}

async function prepareRotationRecords(records: { id: string; plaintext: string; key: string }[]) {
  if (!rotationTableCreated) {
    await pool.query(`CREATE TABLE ${rotationTable} (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, sensitive BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
    )`)
    rotationTableCreated = true
  }
  await pool.query(`TRUNCATE TABLE ${rotationTable}`)
  for (const [index, record] of records.entries()) {
    const ciphertext = withEncryptionKeys(record.key, undefined, () => encryptText(record.plaintext))
    await pool.query(
      `INSERT INTO ${rotationTable} (id, owner_id, category, title, content, sensitive, created_at, updated_at)
       VALUES ($1, $2, 'history', $3, $4, TRUE, $5, $6)`,
      [record.id, rotationOwner, `Synthetic ${index}`, ciphertext, new Date("2026-01-02T03:04:05.000Z"), new Date("2026-02-03T04:05:06.000Z")],
    )
  }
}

async function runReencryptionBatches(options: {
  batchSize?: number
  beforeWrite?: (record: RotationRecord, readerPid: number) => Promise<void>
  afterBatch?: (batch: number) => Promise<void> | void
} = {}): Promise<{ updated: number; skipped: number }> {
  const batchSize = options.batchSize ?? 2
  const reader = await pool.connect()
  let updated = 0
  let skipped = 0
  let cursor = ""
  let batch = 0
  try {
    const readerPid = Number((await reader.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid)
    while (true) {
      const { rows } = await reader.query<RotationRecord>(
        `SELECT id, owner_id, category, title, content, sensitive, created_at, updated_at
         FROM ${rotationTable} WHERE owner_id = $1 AND sensitive = TRUE AND id > $2
         ORDER BY id LIMIT $3`,
        [rotationOwner, cursor, batchSize],
      )
      if (rows.length === 0) break
      for (const record of rows) {
        const alreadyCurrent = decryptWithKey(record.content, newTestKey)
        if (alreadyCurrent !== decryptionFailure) {
          skipped += 1
          cursor = record.id
          continue
        }

        const plaintext = decryptWithKey(record.content, oldTestKey)
        if (plaintext === decryptionFailure) throw new Error("Unreadable encrypted record; batch stopped.")
        const ciphertext = withEncryptionKeys(newTestKey, undefined, () => encryptText(plaintext))
        await options.beforeWrite?.(record, readerPid)
        const result = await reader.query(
          `UPDATE ${rotationTable} SET content = $1
           WHERE id = $2 AND owner_id = $3 AND sensitive = TRUE AND content = $4`,
          [ciphertext, record.id, rotationOwner, record.content],
        )
        if (result.rowCount !== 1) throw new Error(`Concurrent update conflict: expected 1 row, affected ${result.rowCount ?? "unknown"}.`)
        updated += 1
        cursor = record.id
      }
      batch += 1
      await options.afterBatch?.(batch)
    }
    return { updated, skipped }
  } finally {
    reader.release()
  }
}

async function readRotationRecord(id: string): Promise<RotationRecord> {
  const result = await pool.query<RotationRecord>(`SELECT * FROM ${rotationTable} WHERE id = $1`, [id])
  assert.equal(result.rowCount, 1)
  return result.rows[0]!
}

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
  if (rotationTableCreated) await pool.query(`DROP TABLE IF EXISTS ${rotationTable}`)
  clearDatabaseAdapterForTesting()
  await pool.end()
})

test("PostgreSQL connection is the new empty isolated v16 test database before writes", async () => {
  const result = await pool.query<{
    database_name: string
    server_version: string
    public_table_count: number
  }>(`SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version,
      (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public') AS public_table_count`)
  const identity = result.rows[0]
  assert.ok(identity)
  assert.equal(identity.database_name, "jarvis_test", "Refusing DB writes outside jarvis_test.")
  assert.equal(Math.floor(Number(identity.server_version) / 10_000), 16, "Refusing DB writes outside PostgreSQL 16.")
  assert.equal(identity.public_table_count, 0, "Refusing DB writes unless the isolated test database is fresh.")
})

test("PostgreSQL re-encryption preserves metadata and is readable with only the new key", async () => {
  const plaintext = "synthetic historical memory"
  await prepareRotationRecords([{ id: "valid-legacy", plaintext, key: oldTestKey }])
  const result = await runReencryptionBatches()
  const record = await readRotationRecord("valid-legacy")

  assert.deepEqual(result, { updated: 1, skipped: 0 })
  assert.ok(decryptWithKey(record.content, newTestKey) === plaintext, "New key could not read the re-encrypted record.")
  assert.ok(decryptWithKey(record.content, oldTestKey) === decryptionFailure, "Record remained readable with only the old key.")
  assert.deepEqual(
    {
      id: record.id,
      owner_id: record.owner_id,
      category: record.category,
      title: record.title,
      sensitive: record.sensitive,
      created_at: record.created_at.toISOString(),
      updated_at: record.updated_at.toISOString(),
    },
    {
      id: "valid-legacy",
      owner_id: rotationOwner,
      category: "history",
      title: "Synthetic 0",
      sensitive: true,
      created_at: "2026-01-02T03:04:05.000Z",
      updated_at: "2026-02-03T04:05:06.000Z",
    },
  )
})

test("PostgreSQL re-encryption skips current ciphertext byte-for-byte on repeated runs", async () => {
  await prepareRotationRecords([{ id: "already-current", plaintext: "synthetic current memory", key: newTestKey }])
  const before = await readRotationRecord("already-current")

  assert.deepEqual(await runReencryptionBatches(), { updated: 0, skipped: 1 })
  assert.deepEqual(await runReencryptionBatches(), { updated: 0, skipped: 1 })
  const after = await readRotationRecord("already-current")
  assert.ok(after.content === before.content, "Already-current ciphertext changed during retry.")
})

test("PostgreSQL re-encryption resumes after an interruption between batches", async () => {
  const records = [
    { id: "resume-a", plaintext: "synthetic first memory", key: oldTestKey },
    { id: "resume-b", plaintext: "synthetic second memory", key: oldTestKey },
    { id: "resume-c", plaintext: "synthetic third memory", key: oldTestKey },
  ]
  await prepareRotationRecords(records)

  await assert.rejects(
    runReencryptionBatches({
      batchSize: 2,
      afterBatch: (batch) => {
        if (batch === 1) throw new Error("Simulated interruption between batches.")
      },
    }),
    /Simulated interruption between batches/,
  )
  assert.ok(decryptWithKey((await readRotationRecord("resume-a")).content, newTestKey) === records[0]?.plaintext)
  assert.ok(decryptWithKey((await readRotationRecord("resume-b")).content, newTestKey) === records[1]?.plaintext)
  assert.ok(decryptWithKey((await readRotationRecord("resume-c")).content, newTestKey) === decryptionFailure)

  assert.deepEqual(await runReencryptionBatches({ batchSize: 2 }), { updated: 1, skipped: 2 })
  for (const record of records) {
    assert.ok(decryptWithKey((await readRotationRecord(record.id)).content, newTestKey) === record.plaintext)
  }
})

test("PostgreSQL re-encryption detects concurrent changes and preserves the newer ciphertext", async () => {
  const originalPlaintext = "synthetic original memory"
  const newerPlaintext = "synthetic concurrently updated memory"
  await prepareRotationRecords([{ id: "concurrent-update", plaintext: originalPlaintext, key: oldTestKey }])
  const concurrentWriter = await pool.connect()
  try {
    await assert.rejects(
      runReencryptionBatches({
        beforeWrite: async (record, readerPid) => {
          const writerPid = Number((await concurrentWriter.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid)
          assert.notEqual(writerPid, readerPid, "Concurrent update must use a separate database connection.")
          const newerCiphertext = withEncryptionKeys(newTestKey, undefined, () => encryptText(newerPlaintext))
          const result = await concurrentWriter.query(
            `UPDATE ${rotationTable} SET content = $1 WHERE id = $2 AND owner_id = $3`,
            [newerCiphertext, record.id, rotationOwner],
          )
          assert.equal(result.rowCount, 1)
        },
      }),
      /Concurrent update conflict: expected 1 row, affected 0/,
    )
  } finally {
    concurrentWriter.release()
  }
  const record = await readRotationRecord("concurrent-update")
  assert.ok(decryptWithKey(record.content, newTestKey) === newerPlaintext, "Concurrent writer's newer content was not preserved.")
})

test("PostgreSQL re-encryption stops on unreadable ciphertext without changing it", async () => {
  const nextCiphertext = withEncryptionKeys(oldTestKey, undefined, () => encryptText("synthetic untouched memory"))
  await prepareRotationRecords([])
  await pool.query(
    `INSERT INTO ${rotationTable} (id, owner_id, category, title, content, sensitive, created_at, updated_at)
     VALUES ($1, $2, 'history', 'Synthetic corrupt', $3, TRUE, now(), now()),
            ($4, $2, 'history', 'Synthetic next', $5, TRUE, now(), now())`,
    ["unreadable-first", rotationOwner, "enc:v1:invalid:synthetic", "unreadable-next", nextCiphertext],
  )
  const unreadableBefore = await readRotationRecord("unreadable-first")
  const nextBefore = await readRotationRecord("unreadable-next")

  await assert.rejects(runReencryptionBatches(), /Unreadable encrypted record/)
  const unreadableAfter = await readRotationRecord("unreadable-first")
  const nextAfter = await readRotationRecord("unreadable-next")
  assert.ok(unreadableAfter.content === unreadableBefore.content, "Unreadable ciphertext was changed.")
  assert.ok(nextAfter.content === nextBefore.content, "Batch continued after an unreadable record.")
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

test("PostgreSQL approvals bind validated plans to the hash and consume exactly once", async () => {
  const plan = {
    target: "octocat/example",
    action: "Prepare a pull request",
    changes: ["Add a test"],
    impacts: ["No production deployment"],
    critical: true,
  }
  const id = randomUUID()
  const hash = approvalHash(plan)
  await assert.rejects(createApproval(owner, id, hash, JSON.stringify({ ...plan, action: "Deploy production" })), /otisk/i)
  await assert.rejects(createApproval(owner, id, hash, JSON.stringify({ ...plan, extra: true })))
  const created = await createApproval(owner, id, hash, JSON.stringify(plan))
  assert.equal(created.status, "pending")
  assert.equal(await resolveApproval(member, id, hash, "approve"), undefined)
  assert.equal(await resolveApproval(owner, id, approvalHash({ ...plan, action: "Deploy production" }), "approve"), undefined)
  assert.equal(await consumeApproval(owner, id, hash), undefined)
  assert.equal((await resolveApproval(owner, id, hash, "approve"))?.status, "critical_reviewed")
  assert.equal(await consumeApproval(owner, id, hash), undefined)
  assert.equal((await resolveApproval(owner, id, hash, "confirm_critical"))?.status, "approved")
  assert.equal(await consumeApproval(member, id, hash), undefined)
  const attempts = await Promise.all(Array.from({ length: 10 }, () => consumeApproval(owner, id, hash)))
  assert.deepEqual(attempts.filter((result) => result !== undefined), [JSON.stringify(plan)])
  const audit = (await listApprovalAudit(owner)).filter((event) => event.approval_id === id)
  assert.deepEqual(audit.map((event) => event.event).sort(), ["approved", "created", "critical_reviewed", "execution_authorized"])
  assert.equal((await listApprovalAudit(member)).some((event) => event.approval_id === id), false)
})

test("PostgreSQL approval consumption fails closed when its audit write fails", async () => {
  const plan = { target: "octocat/example", action: "Prepare", changes: ["Add test"], impacts: ["No production"], critical: false }
  const id = randomUUID()
  const hash = approvalHash(plan)
  await createApproval(owner, id, hash, JSON.stringify(plan))
  await resolveApproval(owner, id, hash, "approve")
  await pool.query("ALTER TABLE jarvis_approval_audit ADD CONSTRAINT test_block_authorization CHECK (event <> 'execution_authorized') NOT VALID")
  try {
    await assert.rejects(consumeApproval(owner, id, hash))
    const result = await pool.query("SELECT status FROM jarvis_approvals WHERE id = $1", [id])
    assert.equal(result.rows[0]?.status, "approved")
  } finally {
    await pool.query("ALTER TABLE jarvis_approval_audit DROP CONSTRAINT test_block_authorization")
  }
  assert.equal(await consumeApproval(owner, id, hash), JSON.stringify(plan))
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
  const ownerIdempotencyKey = randomUUID()
  const firstWrite = await persistDevelopmentStudioMockRun(owner, owner, ownerIdempotencyKey, ownerRun)
  assert.deepEqual(firstWrite, { runId: ownerRun.id, created: true })
  const replay = await persistDevelopmentStudioMockRun(owner, owner, ownerIdempotencyKey, await createRun(randomUUID()))
  assert.deepEqual(replay, { runId: ownerRun.id, created: false })
  await assert.rejects(
    persistDevelopmentStudioMockRun(owner, owner, ownerIdempotencyKey, await createMockDevelopmentStudioRun({
      id: randomUUID(),
      repository: "octocat/hello-world",
      task: "A different task body",
      taskHash: createHash("sha256").update("A different task body").digest("hex"),
    })),
    DevelopmentStudioIdempotencyConflictError,
  )
  const memberIdempotencyKey = randomUUID()
  const concurrentWrites = await Promise.all([
    persistDevelopmentStudioMockRun(owner, member, memberIdempotencyKey, await createRun(randomUUID())),
    persistDevelopmentStudioMockRun(owner, member, memberIdempotencyKey, await createRun(randomUUID())),
  ])
  assert.equal(concurrentWrites[0]?.runId, concurrentWrites[1]?.runId)
  assert.equal(concurrentWrites.filter((result) => result.created).length, 1)

  const ownerHistory = await listDevelopmentStudioRuns(owner, owner)
  const memberHistory = await listDevelopmentStudioRuns(owner, member)
  assert.deepEqual(ownerHistory.map((run) => run.id), [ownerRun.id])
  assert.deepEqual(memberHistory.map((run) => run.id), [concurrentWrites[0]!.runId])
  assert.deepEqual(await listDevelopmentStudioRuns(member, member), [])
  const ownerEvents = await listDevelopmentStudioEvents(owner, owner, ownerRun.id)
  assert.equal(ownerEvents.length, 19)
  assert.deepEqual(ownerEvents.map((event) => event.sequence), Array.from({ length: 19 }, (_, index) => index))
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
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM jarvis_development_studio_events WHERE run_id = $1", [concurrentWrites[0]!.runId])).rows[0]?.count,
    19,
  )
})
