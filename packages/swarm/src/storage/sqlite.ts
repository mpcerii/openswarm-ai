export * as SwarmSqliteStore from "./sqlite"

import type { Database as BunSqliteDatabase } from "bun:sqlite"
import { DateTime } from "effect"
import { SwarmAgent } from "../agent/agent"
import { SwarmTask } from "../task/task"
import { SwarmMessage } from "../messaging/message"
import { SwarmArtifact } from "../artifacts/artifact"
import { SwarmCensus } from "../census/census"
import { SwarmAudit } from "../audit/audit"
import { SwarmWorker } from "../cluster/worker"
import { SwarmLease } from "../cluster/lease"
import { SwarmIdempotency } from "../cluster/idempotency"
import { SwarmCredentials } from "../cluster/credentials"
import { SwarmQueue } from "../queue/queue"
import type {
  DurableStore,
  SpawnLimits,
  SpawnRejection,
  MissionRecord,
  ConcurrencySnapshot,
  StoreSnapshot,
  MissionBudgetRecord,
  AgentBudgetRecord,
  ChildBudgetAmount,
  MissionAccounting,
} from "./store"
import { CLUSTER_DDL } from "./ddl"

// ---------------------------------------------------------------------------
// SQLite-backed durable store for LOCAL mode: one machine, one runtime, one
// database. This is NOT a distributed store — sharing the file across machines
// or processes is unsupported. A shared durable backend (PostgreSQL) plugs in
// behind the same DurableStore interface for distributed mode.
// ---------------------------------------------------------------------------

const DB = require("bun:sqlite") as { Database: typeof BunSqliteDatabase }

function withState(record: SwarmAgent.AgentRecord, to: SwarmAgent.State, now: number): SwarmAgent.AgentRecord {
  SwarmAgent.transition(record.state, to)
  return { ...record, state: to, time: { created: record.time.created, updated: DateTime.makeUnsafe(now) } }
}

function parseJson<T>(value: string | null | undefined): T | undefined {
  if (value === null || value === undefined) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

class SqliteQueue implements SwarmQueue.Backend {
  readonly kind = "database" as const
  constructor(private readonly db: BunSqliteDatabase) {}

  async publish(msg: SwarmQueue.PublishInput): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO swarm_store_queue (id, kind, payload, visible_at, claim_token, claimed_at, attempts, created_at)
         VALUES (?, ?, ?, ?, NULL, NULL, 0, ?)`,
      )
      .run(msg.id, msg.kind, msg.payload, msg.visibleAt, msg.createdAt)
  }

  async claim(max: number, now: number, kind?: string): Promise<SwarmQueue.Claimed[]> {
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id, kind, payload, attempts FROM swarm_store_queue
           WHERE visible_at <= ? AND claim_token IS NULL AND (? IS NULL OR kind = ?)
           ORDER BY visible_at ASC LIMIT ?`,
        )
        .all(now, kind === undefined ? null : kind, kind === undefined ? null : kind, max) as {
        id: string
        kind: string
        payload: string
        attempts: number
      }[]
      const out: SwarmQueue.Claimed[] = []
      for (const row of rows) {
        const token = `tok_${Math.random().toString(36).slice(2, 10)}`
        this.db
          .prepare(`UPDATE swarm_store_queue SET claim_token = ?, claimed_at = ?, attempts = attempts + 1 WHERE id = ?`)
          .run(token, now, row.id)
        out.push({ id: row.id, kind: row.kind, payload: row.payload, claimToken: token, attempts: row.attempts + 1 })
      }
      return out
    })
    return tx()
  }

  async ack(id: string, claimToken: string): Promise<boolean> {
    const res = this.db.prepare(`DELETE FROM swarm_store_queue WHERE id = ? AND claim_token = ?`).run(id, claimToken)
    return res.changes > 0
  }

  async nack(id: string, claimToken: string, visibleAt: number): Promise<boolean> {
    const res = this.db
      .prepare(`UPDATE swarm_store_queue SET claim_token = NULL, claimed_at = NULL, visible_at = ? WHERE id = ? AND claim_token = ?`)
      .run(visibleAt, id, claimToken)
    return res.changes > 0
  }

  async extend(id: string, claimToken: string, visibleAt: number): Promise<boolean> {
    const res = this.db.prepare(`UPDATE swarm_store_queue SET visible_at = ? WHERE id = ? AND claim_token = ?`).run(visibleAt, id, claimToken)
    return res.changes > 0
  }

  async depth(): Promise<number> {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM swarm_store_queue`).get() as { n: number }
    return row.n
  }
}

export class SqliteStore implements DurableStore {
  readonly kind = "sqlite" as const
  readonly queue: SwarmQueue.Backend
  private readonly db: BunSqliteDatabase
  private readonly limits: SpawnLimits

  constructor(path: string, limits: SpawnLimits, llmCap: number, workspaceCap: number) {
    this.db = new DB.Database(path)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    for (const stmt of CLUSTER_DDL) this.db.exec(stmt)
    this.limits = limits
    this.queue = new SqliteQueue(this.db)
    this.db
      .prepare(
        `INSERT INTO swarm_store_concurrency (id, population, active_agents, active_agents_peak, active_llm, active_llm_peak, active_workspaces, workspace_peak, max_active_llm)
         VALUES (1, 0, 0, 0, 0, 0, 0, 0, ?)
         ON CONFLICT(id) DO UPDATE SET max_active_llm = excluded.max_active_llm`,
      )
      .run(llmCap)
    // Workspace cap is not persisted per-row; it is supplied at call time via
    // atomicTryConsumeWorkspace(max), same as the memory store.
    void workspaceCap
  }

  close(): void {
    this.db.close()
  }

  async getAgent(id: string): Promise<SwarmAgent.AgentRecord | undefined> {
    const row = this.db.prepare(`SELECT payload FROM swarm_store_agent WHERE id = ?`).get(id) as { payload: string } | undefined
    return parseJson<SwarmAgent.AgentRecord>(row?.payload)
  }

  async putAgent(record: SwarmAgent.AgentRecord): Promise<void> {
    this.db
      .prepare(`INSERT INTO swarm_store_agent (id, state, payload, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET state = excluded.state, payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(record.id, record.state, JSON.stringify(record), DateTime.toEpochMillis(record.time.updated))
  }

  async transitionAgent(id: string, to: SwarmAgent.State): Promise<SwarmAgent.AgentRecord | undefined> {
    const current = await this.getAgent(id)
    if (current === undefined) return undefined
    const updated = withState(current, to, Date.now())
    await this.putAgent(updated)
    return updated
  }

  async listAgents(): Promise<SwarmAgent.AgentRecord[]> {
    const rows = this.db.prepare(`SELECT payload FROM swarm_store_agent`).all() as { payload: string }[]
    return rows.flatMap((r) => (parseJson<SwarmAgent.AgentRecord>(r.payload) ? [parseJson<SwarmAgent.AgentRecord>(r.payload)!] : []))
  }

  async listAgentsByState(state: SwarmAgent.State): Promise<SwarmAgent.AgentRecord[]> {
    const rows = this.db.prepare(`SELECT payload FROM swarm_store_agent WHERE state = ?`).all(state) as { payload: string }[]
    return rows.flatMap((r) => (parseJson<SwarmAgent.AgentRecord>(r.payload) ? [parseJson<SwarmAgent.AgentRecord>(r.payload)!] : []))
  }

  async putMission(mission: MissionRecord): Promise<void> {
    this.db.prepare(`INSERT INTO swarm_store_mission (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`).run(mission.id, JSON.stringify(mission))
  }

  async getMission(id: string): Promise<MissionRecord | undefined> {
    const row = this.db.prepare(`SELECT payload FROM swarm_store_mission WHERE id = ?`).get(id) as { payload: string } | undefined
    return parseJson<MissionRecord>(row?.payload)
  }

  async listMissions(): Promise<MissionRecord[]> {
    const rows = this.db.prepare(`SELECT payload FROM swarm_store_mission`).all() as { payload: string }[]
    return rows.flatMap((r) => (parseJson<MissionRecord>(r.payload) ? [parseJson<MissionRecord>(r.payload)!] : []))
  }

  async putCensus(census: SwarmCensus.Info): Promise<void> {
    this.db.prepare(`INSERT INTO swarm_store_census (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`).run(census.id, JSON.stringify(census))
  }

  async getCensus(id: string): Promise<SwarmCensus.Info | undefined> {
    const row = this.db.prepare(`SELECT payload FROM swarm_store_census WHERE id = ?`).get(id) as { payload: string } | undefined
    return parseJson<SwarmCensus.Info>(row?.payload)
  }

  async putMessage(message: SwarmMessage.Info): Promise<void> {
    this.db.prepare(`INSERT INTO swarm_store_message (id, to_agent, payload) VALUES (?, ?, ?)`).run(message.id, message.to, JSON.stringify(message))
  }

  async messagesForAgent(id: string): Promise<SwarmMessage.Info[]> {
    const rows = this.db.prepare(`SELECT payload FROM swarm_store_message WHERE to_agent = ? ORDER BY payload`).all(id) as { payload: string }[]
    return rows.flatMap((r) => (parseJson<SwarmMessage.Info>(r.payload) ? [parseJson<SwarmMessage.Info>(r.payload)!] : []))
  }

  async putTask(task: SwarmTask.Info): Promise<void> {
    this.db.prepare(`INSERT INTO swarm_store_task (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`).run(task.id, JSON.stringify(task))
  }

  async listTasks(): Promise<SwarmTask.Info[]> {
    const rows = this.db.prepare(`SELECT payload FROM swarm_store_task`).all() as { payload: string }[]
    return rows.flatMap((r) => (parseJson<SwarmTask.Info>(r.payload) ? [parseJson<SwarmTask.Info>(r.payload)!] : []))
  }

  async putArtifact(record: SwarmArtifact.PatchRecord): Promise<void> {
    this.db.prepare(`INSERT INTO swarm_store_artifact (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`).run(record.artifact.id, JSON.stringify(record))
  }

  async listArtifacts(): Promise<SwarmArtifact.PatchRecord[]> {
    const rows = this.db.prepare(`SELECT payload FROM swarm_store_artifact`).all() as { payload: string }[]
    return rows.flatMap((r) => (parseJson<SwarmArtifact.PatchRecord>(r.payload) ? [parseJson<SwarmArtifact.PatchRecord>(r.payload)!] : []))
  }

  async appendAudit(entry: SwarmAudit.StoredEvent): Promise<void> {
    this.db.prepare(`INSERT INTO swarm_store_audit (type, payload) VALUES (?, ?)`).run(entry.type, JSON.stringify({ time: entry.time, data: entry.data }))
  }

  async auditEvents(): Promise<SwarmAudit.StoredEvent[]> {
    const rows = this.db.prepare(`SELECT type, payload FROM swarm_store_audit ORDER BY seq ASC`).all() as { type: string; payload: string }[]
    return rows.flatMap((r) => {
      const inner = parseJson<{ time: number; data: unknown }>(r.payload)
      return inner ? [{ type: r.type, time: inner.time, data: inner.data } as SwarmAudit.StoredEvent] : []
    })
  }

  async eventsByType(type: string): Promise<SwarmAudit.StoredEvent[]> {
    const rows = this.db.prepare(`SELECT payload FROM swarm_store_audit WHERE type = ?`).all(type) as { payload: string }[]
    return rows.flatMap((r) => {
      const inner = parseJson<{ time: number; data: unknown }>(r.payload)
      return inner ? [{ type, time: inner.time, data: inner.data } as SwarmAudit.StoredEvent] : []
    })
  }

  async hasModelOverrides(): Promise<boolean> {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM swarm_store_model`).get() as { n: number }
    return row.n > 0
  }

  async listEnabledModels(): Promise<string[]> {
    const rows = this.db.prepare(`SELECT id FROM swarm_store_model WHERE enabled = 1`).all() as { id: string }[]
    return rows.map((r) => r.id)
  }

  async setModelEnabled(id: string, enabled: boolean): Promise<void> {
    this.db.prepare(`INSERT INTO swarm_store_model (id, enabled) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled`).run(id, enabled ? 1 : 0)
  }

  async putWorker(record: SwarmWorker.Record): Promise<void> {
    this.db
      .prepare(`INSERT INTO swarm_store_worker (id, payload, health, last_heartbeat) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, health = excluded.health, last_heartbeat = excluded.last_heartbeat`)
      .run(record.id, JSON.stringify(record), record.health, record.last_heartbeat)
  }

  async getWorker(id: string): Promise<SwarmWorker.Record | undefined> {
    const row = this.db.prepare(`SELECT payload FROM swarm_store_worker WHERE id = ?`).get(id) as { payload: string } | undefined
    return parseJson<SwarmWorker.Record>(row?.payload)
  }

  async listWorkers(): Promise<SwarmWorker.Record[]> {
    const rows = this.db.prepare(`SELECT payload FROM swarm_store_worker`).all() as { payload: string }[]
    return rows.flatMap((r) => (parseJson<SwarmWorker.Record>(r.payload) ? [parseJson<SwarmWorker.Record>(r.payload)!] : []))
  }

  async removeWorker(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM swarm_store_worker WHERE id = ?`).run(id)
  }

  async putLease(record: SwarmLease.Record): Promise<void> {
    this.db
      .prepare(`INSERT INTO swarm_store_lease (id, agent_id, worker_id, status, expires_at, payload) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id, worker_id = excluded.worker_id, status = excluded.status, expires_at = excluded.expires_at, payload = excluded.payload`)
      .run(record.id, record.agent_id, record.worker_id, record.status, record.expires_at, JSON.stringify(record))
  }

  async getLease(id: string): Promise<SwarmLease.Record | undefined> {
    const row = this.db.prepare(`SELECT payload FROM swarm_store_lease WHERE id = ?`).get(id) as { payload: string } | undefined
    return parseJson<SwarmLease.Record>(row?.payload)
  }

  async listLeases(): Promise<SwarmLease.Record[]> {
    const rows = this.db.prepare(`SELECT payload FROM swarm_store_lease`).all() as { payload: string }[]
    return rows.flatMap((r) => (parseJson<SwarmLease.Record>(r.payload) ? [parseJson<SwarmLease.Record>(r.payload)!] : []))
  }

  async listLeasesByWorker(workerID: string): Promise<SwarmLease.Record[]> {
    const rows = this.db.prepare(`SELECT payload FROM swarm_store_lease WHERE worker_id = ?`).all(workerID) as { payload: string }[]
    return rows.flatMap((r) => (parseJson<SwarmLease.Record>(r.payload) ? [parseJson<SwarmLease.Record>(r.payload)!] : []))
  }

  async listLeasesByAgent(agentID: string): Promise<SwarmLease.Record[]> {
    const rows = this.db.prepare(`SELECT payload FROM swarm_store_lease WHERE agent_id = ?`).all(agentID) as { payload: string }[]
    return rows.flatMap((r) => (parseJson<SwarmLease.Record>(r.payload) ? [parseJson<SwarmLease.Record>(r.payload)!] : []))
  }

  async atomicClaimLease(id: string, workerID: string, now: number): Promise<{ ok: true; lease: SwarmLease.Record } | { ok: false; reason: string }> {
    const tx = this.db.transaction(() => {
      const current = this.getLeaseSync(id)
      if (current === undefined) return { ok: false, reason: "unknown lease" } as const
      if (current.status !== "pending") return { ok: false, reason: `lease not claimable (${current.status})` } as const
      if (current.expires_at <= now) return { ok: false, reason: "lease expired before claim" } as const
      const updated: SwarmLease.Record = { ...current, worker_id: workerID, status: "claimed", last_heartbeat: now }
      this.putLeaseSync(updated)
      return { ok: true, lease: updated } as const
    })
    return tx()
  }

  async atomicCompleteLease(id: string, workerID: string, result: unknown, now: number): Promise<{ ok: true; lease: SwarmLease.Record } | { ok: false; reason: string }> {
    const tx = this.db.transaction(() => {
      const current = this.getLeaseSync(id)
      if (current === undefined) return { ok: false, reason: "unknown lease" } as const
      if (current.worker_id !== workerID) return { ok: false, reason: "lease held by another worker" } as const
      const updated: SwarmLease.Record = {
        ...current,
        status: "completed",
        last_heartbeat: now,
        expires_at: now,
        result: typeof result === "string" ? result : JSON.stringify(result ?? null),
      }
      this.putLeaseSync(updated)
      return { ok: true, lease: updated } as const
    })
    return tx()
  }

  async touchLeaseHeartbeat(id: string, workerID: string, now: number, expiresAt: number): Promise<boolean> {
    const tx = this.db.transaction(() => {
      const current = this.getLeaseSync(id)
      if (current === undefined || current.worker_id !== workerID) return false
      if (current.status === "completed" || current.status === "failed" || current.status === "expired") return false
      this.putLeaseSync({ ...current, last_heartbeat: now, expires_at: expiresAt })
      return true
    })
    return tx()
  }

  async expireLeases(workerID: string | undefined, now: number): Promise<string[]> {
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id FROM swarm_store_lease WHERE status NOT IN ('completed', 'failed', 'expired') AND expires_at <= ? AND (? IS NULL OR worker_id = ?)`,
        )
        .all(now, workerID === undefined ? null : workerID, workerID === undefined ? null : workerID) as { id: string }[]
      for (const row of rows) {
        const lease = this.getLeaseSync(row.id)
        if (lease) this.putLeaseSync({ ...lease, status: "expired", last_heartbeat: now })
      }
      return rows.map((r) => r.id)
    })
    return tx()
  }

  private getLeaseSync(id: string): SwarmLease.Record | undefined {
    const row = this.db.prepare(`SELECT payload FROM swarm_store_lease WHERE id = ?`).get(id) as { payload: string } | undefined
    return parseJson<SwarmLease.Record>(row?.payload)
  }

  private putLeaseSync(record: SwarmLease.Record): void {
    this.db
      .prepare(`INSERT INTO swarm_store_lease (id, agent_id, worker_id, status, expires_at, payload) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id, worker_id = excluded.worker_id, status = excluded.status, expires_at = excluded.expires_at, payload = excluded.payload`)
      .run(record.id, record.agent_id, record.worker_id, record.status, record.expires_at, JSON.stringify(record))
  }

  async beginOperation(record: SwarmIdempotency.Record): Promise<{ duplicate: true; result: unknown } | { duplicate: false }> {
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT id, result, completed_at FROM swarm_store_op WHERE kind = ? AND op_key = ?`)
        .get(record.kind, record.op_key) as { id: string; result: string | null; completed_at: number | null } | undefined
      if (existing != null) {
        // Only a COMPLETED operation replays; an uncompleted one (crashed
        // before completion) is adopted by the retry so it can finish.
        if (existing.completed_at !== null) {
          const result = existing.result === null ? undefined : parseJson<unknown>(existing.result)
          return { duplicate: true, result } as const
        }
        this.db
          .prepare(`UPDATE swarm_store_op SET id = ?, result = NULL, completed_at = NULL WHERE kind = ? AND op_key = ?`)
          .run(record.id, record.kind, record.op_key)
        return { duplicate: false } as const
      }
      this.db.prepare(`INSERT INTO swarm_store_op (id, kind, op_key, result, completed_at, created_at) VALUES (?, ?, ?, NULL, NULL, ?)`).run(record.id, record.kind, record.op_key, record.created_at)
      return { duplicate: false } as const
    })
    return tx()
  }

  async completeOperation(id: string, result: unknown, now: number): Promise<void> {
    this.db.prepare(`UPDATE swarm_store_op SET result = ?, completed_at = ? WHERE id = ?`).run(JSON.stringify(result ?? null), now, id)
  }

  async hasOperation(kind: SwarmIdempotency.Kind, key: string): Promise<boolean> {
    const row = this.db.prepare(`SELECT id FROM swarm_store_op WHERE kind = ? AND op_key = ?`).get(kind, key) as { id: string } | undefined
    return row != null
  }

  async listOperations(): Promise<SwarmIdempotency.Record[]> {
    const rows = this.db.prepare(`SELECT id, kind, op_key, result, claimed_by, created_at, completed_at FROM swarm_store_op`).all() as {
      id: string
      kind: string
      op_key: string
      result: string | null
      claimed_by: string | null
      created_at: number
      completed_at: number | null
    }[]
    return rows.map((r) => ({ id: r.id, kind: r.kind as SwarmIdempotency.Kind, op_key: r.op_key, result: r.result, claimed_by: r.claimed_by, created_at: r.created_at, completed_at: r.completed_at }))
  }

  async putCredential(record: SwarmCredentials.Record): Promise<void> {
    this.db.prepare(`INSERT INTO swarm_store_credential (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`).run(record.id, JSON.stringify(record))
  }

  async getCredential(id: string): Promise<SwarmCredentials.Record | undefined> {
    const row = this.db.prepare(`SELECT payload FROM swarm_store_credential WHERE id = ?`).get(id) as { payload: string } | undefined
    return parseJson<SwarmCredentials.Record>(row?.payload)
  }

  async listCredentials(): Promise<SwarmCredentials.Record[]> {
    const rows = this.db.prepare(`SELECT payload FROM swarm_store_credential`).all() as { payload: string }[]
    return rows.flatMap((r) => (parseJson<SwarmCredentials.Record>(r.payload) ? [parseJson<SwarmCredentials.Record>(r.payload)!] : []))
  }

  async putSecret(secret: SwarmCredentials.Secret): Promise<void> {
    this.db.prepare(`INSERT INTO swarm_store_secret (ref, value, scope) VALUES (?, ?, ?) ON CONFLICT(ref) DO UPDATE SET value = excluded.value, scope = excluded.scope`).run(secret.ref, secret.value, secret.scope)
  }

  async getSecret(ref: string): Promise<SwarmCredentials.Secret | undefined> {
    const row = this.db.prepare(`SELECT ref, value, scope FROM swarm_store_secret WHERE ref = ?`).get(ref) as { ref: string; value: string; scope: string } | undefined
    return row ? { ref: row.ref, value: row.value, scope: row.scope } : undefined
  }

  async atomicTryConsumeSpawn(parentID: string | undefined, depth: number): Promise<{ ok: true; depth: number } | { ok: false; code: SpawnRejection }> {
    const tx = this.db.transaction(() => {
      const budget = this.db.prepare(`SELECT population FROM swarm_store_concurrency WHERE id = 1`).get() as { population: number }
      if (budget.population + 1 > this.limits.max_agents) return { ok: false, code: "population_exceeded" } as const
      if (depth > this.limits.max_depth) return { ok: false, code: "depth_exceeded" } as const
      if (parentID !== undefined) {
        const row = this.db.prepare(`SELECT children FROM swarm_store_spawn WHERE parent_id = ?`).get(parentID) as { children: number } | undefined
        const children = row?.children ?? 0
        if (children + 1 > this.limits.max_children_per_agent) return { ok: false, code: "children_exceeded" } as const
        this.db.prepare(`INSERT INTO swarm_store_spawn (parent_id, children) VALUES (?, 1) ON CONFLICT(parent_id) DO UPDATE SET children = children + 1`).run(parentID)
      }
      this.db.prepare(`UPDATE swarm_store_concurrency SET population = population + 1 WHERE id = 1`).run()
      return { ok: true, depth } as const
    })
    return tx()
  }

  async atomicReleaseSpawn(parentID: string | undefined): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE swarm_store_concurrency SET population = MAX(0, population - 1) WHERE id = 1`).run()
      if (parentID !== undefined) {
        this.db.prepare(`UPDATE swarm_store_spawn SET children = MAX(0, children - 1) WHERE parent_id = ?`).run(parentID)
      }
    })
    tx()
  }

  async atomicTryAdmitAgent(): Promise<boolean> {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT active_agents, active_agents_peak, MAX(active_agents, ?) AS cap FROM swarm_store_concurrency WHERE id = 1`).get(this.limits.max_active_agents) as {
        active_agents: number
        active_agents_peak: number
        cap: number
      }
      if (row.active_agents >= this.limits.max_active_agents) return false
      this.db.prepare(`UPDATE swarm_store_concurrency SET active_agents = active_agents + 1, active_agents_peak = MAX(active_agents_peak, active_agents + 1) WHERE id = 1`).run()
      return true
    })
    return tx()
  }

  async atomicReleaseAgent(): Promise<void> {
    this.db.prepare(`UPDATE swarm_store_concurrency SET active_agents = MAX(0, active_agents - 1) WHERE id = 1`).run()
  }

  async atomicTryReserveLLM(): Promise<boolean> {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT active_llm, max_active_llm FROM swarm_store_concurrency WHERE id = 1`).get() as { active_llm: number; max_active_llm: number }
      if (row.active_llm >= row.max_active_llm) return false
      this.db.prepare(`UPDATE swarm_store_concurrency SET active_llm = active_llm + 1, active_llm_peak = MAX(active_llm_peak, active_llm + 1) WHERE id = 1`).run()
      return true
    })
    return tx()
  }

  async atomicReleaseLLM(): Promise<void> {
    this.db.prepare(`UPDATE swarm_store_concurrency SET active_llm = MAX(0, active_llm - 1) WHERE id = 1`).run()
  }

  async atomicTryConsumeWorkspace(max: number): Promise<boolean> {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT active_workspaces FROM swarm_store_concurrency WHERE id = 1`).get() as { active_workspaces: number }
      if (row.active_workspaces >= max) return false
      this.db.prepare(`UPDATE swarm_store_concurrency SET active_workspaces = active_workspaces + 1, workspace_peak = MAX(workspace_peak, active_workspaces + 1) WHERE id = 1`).run()
      return true
    })
    return tx()
  }

  async atomicReleaseWorkspace(): Promise<void> {
    this.db.prepare(`UPDATE swarm_store_concurrency SET active_workspaces = MAX(0, active_workspaces - 1) WHERE id = 1`).run()
  }

  async putMissionBudget(record: MissionBudgetRecord): Promise<void> {
    this.db
      .prepare(`INSERT INTO swarm_store_mission_budget (mission_id, payload) VALUES (?, ?)
        ON CONFLICT(mission_id) DO UPDATE SET payload = excluded.payload`)
      .run(record.missionID, JSON.stringify(record))
  }

  async getMissionBudget(missionID: string): Promise<MissionBudgetRecord | undefined> {
    const row = this.db.prepare(`SELECT payload FROM swarm_store_mission_budget WHERE mission_id = ?`).get(missionID) as { payload: string } | undefined
    return parseJson<MissionBudgetRecord>(row?.payload)
  }

  async atomicTryConsumeMissionCall(missionID: string): Promise<boolean> {
    const tx = this.db.transaction(() => {
      const current = this.getMissionBudgetSync(missionID)
      if (current === undefined) return true
      const max = current.max_model_calls
      if (max !== undefined && current.used_calls + 1 > max) {
        this.putMissionBudgetSync({ ...current, hard_reached: true })
        return false
      }
      this.putMissionBudgetSync({ ...current, used_calls: current.used_calls + 1 })
      return true
    })
    return tx()
  }

  async atomicAddMissionTokens(missionID: string, tokens: number): Promise<number> {
    const tx = this.db.transaction(() => {
      const current = this.getMissionBudgetSync(missionID)
      if (current === undefined || tokens <= 0) return current?.used_tokens ?? 0
      const next = { ...current, used_tokens: current.used_tokens + tokens }
      if (current.max_tokens !== undefined && next.used_tokens >= current.max_tokens) next.hard_reached = true
      this.putMissionBudgetSync(next)
      return next.used_tokens
    })
    return tx()
  }

  async atomicRaiseMissionLimits(missionID: string, increase: Partial<MissionBudgetRecord>): Promise<void> {
    const tx = this.db.transaction(() => {
      const current = this.getMissionBudgetSync(missionID)
      if (current === undefined) return
      const next = { ...current }
      const add = (field: "max_model_calls" | "max_tokens" | "max_wall_ms" | "max_cost") => {
        const inc = increase[field]
        if (inc === undefined) return
        next[field] = current[field] === undefined ? inc : (current[field] as number) + inc
      }
      add("max_model_calls")
      add("max_tokens")
      add("max_wall_ms")
      add("max_cost")
      if (increase.max_agents !== undefined) next.max_agents = current.max_agents === undefined ? increase.max_agents : current.max_agents + increase.max_agents
      if (increase.max_active_agents !== undefined) next.max_active_agents = current.max_active_agents === undefined ? increase.max_active_agents : current.max_active_agents + increase.max_active_agents
      next.hard_reached = false
      this.putMissionBudgetSync(next)
    })
    tx()
  }

  async atomicSeedAgentBudget(record: AgentBudgetRecord): Promise<void> {
    this.db
      .prepare(`INSERT INTO swarm_store_agent_budget (agent_id, parent_id, mission_id, payload) VALUES (?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET parent_id = excluded.parent_id, mission_id = excluded.mission_id, payload = excluded.payload`)
      .run(record.agentID, record.parentID, record.missionID, JSON.stringify(record))
  }

  async atomicDelegateChildBudget(missionID: string, parentID: string, childID: string, amount: ChildBudgetAmount): Promise<{ ok: true } | { ok: false; code: "parent_budget_exhausted" | "no_parent_allocation" }> {
    const tx = this.db.transaction(() => {
      const parent = this.getAgentBudgetSync(parentID)
      if (parent === undefined) return { ok: false, code: "no_parent_allocation" } as const
      if (parent.remaining_calls < amount.model_calls || parent.remaining_tokens < amount.tokens || parent.remaining_cost < amount.cost) {
        return { ok: false, code: "parent_budget_exhausted" } as const
      }
      this.putAgentBudgetSync({
        ...parent,
        remaining_calls: parent.remaining_calls - amount.model_calls,
        remaining_tokens: parent.remaining_tokens - amount.tokens,
        remaining_cost: parent.remaining_cost - amount.cost,
      })
      this.putAgentBudgetSync({
        agentID: childID,
        parentID,
        missionID,
        remaining_calls: amount.model_calls,
        remaining_tokens: amount.tokens,
        remaining_cost: amount.cost,
      })
      return { ok: true } as const
    })
    return tx()
  }

  async atomicReclaimChildBudget(missionID: string, childID: string): Promise<void> {
    const tx = this.db.transaction(() => {
      const child = this.getAgentBudgetSync(childID)
      if (child === undefined || child.missionID !== missionID) return
      const parentID = child.parentID
      this.db.prepare(`DELETE FROM swarm_store_agent_budget WHERE agent_id = ?`).run(childID)
      if (parentID !== null) {
        const parent = this.getAgentBudgetSync(parentID)
        if (parent !== undefined) {
          this.putAgentBudgetSync({
            ...parent,
            remaining_calls: parent.remaining_calls + child.remaining_calls,
            remaining_tokens: parent.remaining_tokens + child.remaining_tokens,
            remaining_cost: parent.remaining_cost + child.remaining_cost,
          })
        }
      }
    })
    tx()
  }

  async atomicTryConsumeAgentBudget(agentID: string, calls = 1, tokens = 0, cost = 0): Promise<boolean> {
    const tx = this.db.transaction(() => {
      const current = this.getAgentBudgetSync(agentID)
      if (current === undefined) return true
      if (current.remaining_calls < calls || current.remaining_tokens < tokens || current.remaining_cost < cost) return false
      this.putAgentBudgetSync({
        ...current,
        remaining_calls: current.remaining_calls - calls,
        remaining_tokens: current.remaining_tokens - tokens,
        remaining_cost: current.remaining_cost - cost,
      })
      return true
    })
    return tx()
  }

  async atomicAgentBudgetRemaining(agentID: string): Promise<ChildBudgetAmount | undefined> {
    const current = this.getAgentBudgetSync(agentID)
    if (current === undefined) return undefined
    return { model_calls: current.remaining_calls, tokens: current.remaining_tokens, cost: current.remaining_cost }
  }

  async missionAccounting(missionID: string): Promise<MissionAccounting | undefined> {
    const current = this.getMissionBudgetSync(missionID)
    if (current === undefined) return undefined
    return {
      missionID,
      used_calls: current.used_calls,
      used_tokens: current.used_tokens,
      max_model_calls: current.max_model_calls,
      max_tokens: current.max_tokens,
      max_wall_ms: current.max_wall_ms,
      max_cost: current.max_cost,
      hard_reached: current.hard_reached,
      started_at: current.started_at,
    }
  }

  private getMissionBudgetSync(missionID: string): MissionBudgetRecord | undefined {
    const row = this.db.prepare(`SELECT payload FROM swarm_store_mission_budget WHERE mission_id = ?`).get(missionID) as { payload: string } | undefined
    return parseJson<MissionBudgetRecord>(row?.payload)
  }

  private putMissionBudgetSync(record: MissionBudgetRecord): void {
    this.db
      .prepare(`INSERT INTO swarm_store_mission_budget (mission_id, payload) VALUES (?, ?)
        ON CONFLICT(mission_id) DO UPDATE SET payload = excluded.payload`)
      .run(record.missionID, JSON.stringify(record))
  }

  private getAgentBudgetSync(agentID: string): AgentBudgetRecord | undefined {
    const row = this.db.prepare(`SELECT payload FROM swarm_store_agent_budget WHERE agent_id = ?`).get(agentID) as { payload: string } | undefined
    return parseJson<AgentBudgetRecord>(row?.payload)
  }

  private putAgentBudgetSync(record: AgentBudgetRecord): void {
    this.db
      .prepare(`INSERT INTO swarm_store_agent_budget (agent_id, parent_id, mission_id, payload) VALUES (?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET parent_id = excluded.parent_id, mission_id = excluded.mission_id, payload = excluded.payload`)
      .run(record.agentID, record.parentID, record.missionID, JSON.stringify(record))
  }

  async accounting(): Promise<ConcurrencySnapshot> {
    const row = this.db
      .prepare(
        `SELECT population, active_agents, active_agents_peak, active_llm, active_llm_peak, active_workspaces, workspace_peak, max_active_llm FROM swarm_store_concurrency WHERE id = 1`,
      )
      .get() as {
      population: number
      active_agents: number
      active_agents_peak: number
      active_llm: number
      active_llm_peak: number
      active_workspaces: number
      workspace_peak: number
      max_active_llm: number
    }
    return {
      population: row.population,
      activeAgents: row.active_agents,
      activeLLM: row.active_llm,
      activeWorkspaces: row.active_workspaces,
      activeAgentsPeak: row.active_agents_peak,
      activeLLMPeak: row.active_llm_peak,
      maxAgents: this.limits.max_agents,
      maxActiveAgents: this.limits.max_active_agents,
      maxActiveLLM: row.max_active_llm,
      maxActiveWorkspaces: this.limits.max_active_agents,
    }
  }

  async snapshot(): Promise<StoreSnapshot> {
    const agents = (await this.listAgents()).length
    const [workers, leases, operations, accounting, queueDepth] = await Promise.all([
      this.listWorkers(),
      this.listLeases(),
      this.listOperations(),
      this.accounting(),
      this.queue.depth(),
    ])
    return { agents, workers, leases, operations, accounting, queueDepth }
  }
}
