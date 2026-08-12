export * as SwarmStore from "./store"

import type { SwarmAgent } from "../agent/agent"
import type { SwarmTask } from "../task/task"
import type { SwarmMessage } from "../messaging/message"
import type { SwarmArtifact } from "../artifacts/artifact"
import type { SwarmCensus } from "../census/census"
import type { SwarmAudit } from "../audit/audit"
import type { SwarmWorker } from "../cluster/worker"
import type { SwarmLease } from "../cluster/lease"
import type { SwarmIdempotency } from "../cluster/idempotency"
import type { SwarmCredentials } from "../cluster/credentials"
import type { SwarmQueue } from "../queue/queue"

// ---------------------------------------------------------------------------
// Durable shared state. The control plane owns a single DurableStore; workers
// never touch it directly — they only ever talk to the control plane through
// the transport. Local mode keeps SQLite; distributed mode plugs a shared
// backend (e.g. PostgreSQL) behind the same interface, which is why every
// method is async. No home-grown distributed consensus protocol: the store
// guarantees atomicity of the primitive operations the runtime needs, and
// everything else composes on top.
// ---------------------------------------------------------------------------

export interface SpawnLimits {
  readonly max_agents: number
  readonly max_active_agents: number
  readonly max_depth: number
  readonly max_children_per_agent: number
}

export type SpawnRejection = "population_exceeded" | "depth_exceeded" | "children_exceeded"

export interface MissionRecord {
  id: string
  author: string
  title: string
  brief: string
  planApproved: boolean
  integrationApproved: boolean
  primaryAgentID: SwarmAgent.ID
  createdAt: number
}

export interface ConcurrencySnapshot {
  population: number
  activeAgents: number
  activeLLM: number
  activeWorkspaces: number
  activeAgentsPeak: number
  activeLLMPeak: number
  maxAgents: number
  maxActiveAgents: number
  maxActiveLLM: number
  maxActiveWorkspaces: number
}

// Consistent view used by observability and the simulation harness.
export interface StoreSnapshot {
  agents: number
  workers: SwarmWorker.Record[]
  leases: SwarmLease.Record[]
  operations: SwarmIdempotency.Record[]
  accounting: ConcurrencySnapshot
  queueDepth: number
}

// ------------------------------------------------------------------ budgets
// Durable mission-level budget record. Counters are updated atomically; limits
// may be raised by human approval (which clears the hard flag so scheduling
// can resume).
export interface MissionBudgetRecord {
  missionID: string
  max_agents?: number
  max_active_agents?: number
  max_model_calls?: number
  max_tokens?: number
  max_wall_ms?: number
  max_cost?: number
  used_calls: number
  used_tokens: number
  started_at: number
  hard_reached: boolean
}

export interface ChildBudgetAmount {
  model_calls: number
  tokens: number
  cost: number
}

// Per-agent delegation record. `remaining_*` is the parent's unspent share;
// children can never mint capacity beyond what was delegated to them.
export interface AgentBudgetRecord {
  agentID: string
  parentID: string | null
  missionID: string
  remaining_calls: number
  remaining_tokens: number
  remaining_cost: number
}

export interface MissionAccounting {
  missionID: string
  used_calls: number
  used_tokens: number
  max_model_calls?: number
  max_tokens?: number
  max_wall_ms?: number
  max_cost?: number
  hard_reached: boolean
  started_at: number
}

export interface DurableStore {
  readonly kind: "memory" | "sqlite"
  readonly queue: SwarmQueue.Backend

  // ------------------------------------------------------------------ agents
  getAgent(id: string): Promise<SwarmAgent.AgentRecord | undefined>
  putAgent(record: SwarmAgent.AgentRecord): Promise<void>
  // Validates the transition via SwarmAgent.transition (illegal transitions
  // throw). Returns the updated record.
  transitionAgent(id: string, to: SwarmAgent.State): Promise<SwarmAgent.AgentRecord | undefined>
  listAgents(): Promise<SwarmAgent.AgentRecord[]>
  listAgentsByState(state: SwarmAgent.State): Promise<SwarmAgent.AgentRecord[]>

  // --------------------------------------------------------- missions/census
  putMission(mission: MissionRecord): Promise<void>
  getMission(id: string): Promise<MissionRecord | undefined>
  listMissions(): Promise<MissionRecord[]>
  putCensus(census: SwarmCensus.Info): Promise<void>
  getCensus(id: string): Promise<SwarmCensus.Info | undefined>

  // --------------------------------------------- messages/tasks/artifacts
  putMessage(message: SwarmMessage.Info): Promise<void>
  messagesForAgent(id: string): Promise<SwarmMessage.Info[]>
  putTask(task: SwarmTask.Info): Promise<void>
  listTasks(): Promise<SwarmTask.Info[]>
  putArtifact(record: SwarmArtifact.PatchRecord): Promise<void>
  listArtifacts(): Promise<SwarmArtifact.PatchRecord[]>

  // ------------------------------------------------------------------ audit
  appendAudit(entry: SwarmAudit.StoredEvent): Promise<void>
  auditEvents(): Promise<SwarmAudit.StoredEvent[]>
  eventsByType(type: string): Promise<SwarmAudit.StoredEvent[]>

  // ----------------------------------------------------------------- workers
  putWorker(record: SwarmWorker.Record): Promise<void>
  getWorker(id: string): Promise<SwarmWorker.Record | undefined>
  listWorkers(): Promise<SwarmWorker.Record[]>
  removeWorker(id: string): Promise<void>

  // ----------------------------------------------------------------- leases
  putLease(record: SwarmLease.Record): Promise<void>
  getLease(id: string): Promise<SwarmLease.Record | undefined>
  listLeases(): Promise<SwarmLease.Record[]>
  listLeasesByWorker(workerID: string): Promise<SwarmLease.Record[]>
  listLeasesByAgent(agentID: string): Promise<SwarmLease.Record[]>
  // Atomically move a pending lease to claimed for the given worker. Only one
  // worker can win the transition.
  atomicClaimLease(id: string, workerID: string, now: number): Promise<{ ok: true; lease: SwarmLease.Record } | { ok: false; reason: string }>
  // Atomically complete a claimed lease; returns the lease if the worker is
  // still its holder.
  atomicCompleteLease(id: string, workerID: string, result: unknown, now: number): Promise<{ ok: true; lease: SwarmLease.Record } | { ok: false; reason: string }>
  touchLeaseHeartbeat(id: string, workerID: string, now: number, expiresAt: number): Promise<boolean>
  // Expire stale leases (for a specific worker or all) and return their ids.
  expireLeases(workerID: string | undefined, now: number): Promise<string[]>

  // ------------------------------------------------------------ idempotency
  // Atomically register an operation. If a completed entry already exists for
  // (kind, key) the recorded result is returned and nothing is re-executed.
  beginOperation(record: SwarmIdempotency.Record): Promise<{ duplicate: true; result: unknown } | { duplicate: false }>
  completeOperation(id: string, result: unknown, now: number): Promise<void>
  hasOperation(kind: SwarmIdempotency.Kind, key: string): Promise<boolean>
  listOperations(): Promise<SwarmIdempotency.Record[]>

  // --------------------------------------------- credentials & secrets
  putCredential(record: SwarmCredentials.Record): Promise<void>
  getCredential(id: string): Promise<SwarmCredentials.Record | undefined>
  listCredentials(): Promise<SwarmCredentials.Record[]>
  putSecret(secret: SwarmCredentials.Secret): Promise<void>
  getSecret(ref: string): Promise<SwarmCredentials.Secret | undefined>

  // --------------------------------------------- global accounting (atomic)
  // population + children-per-parent consumption, exactly-once under
  // concurrency. Mirrors the pure SwarmBudget rules against durable counters.
  atomicTryConsumeSpawn(parentID: string | undefined, depth: number): Promise<{ ok: true; depth: number } | { ok: false; code: SpawnRejection }>
  atomicReleaseSpawn(parentID: string | undefined): Promise<void>
  atomicTryAdmitAgent(): Promise<boolean>
  atomicReleaseAgent(): Promise<void>
  atomicTryReserveLLM(): Promise<boolean>
  atomicReleaseLLM(): Promise<void>
  atomicTryConsumeWorkspace(max: number): Promise<boolean>
  atomicReleaseWorkspace(): Promise<void>
  accounting(): Promise<ConcurrencySnapshot>

  // --------------------------------------------- mission/child budgets (atomic)
  // Budget accounting is exactly-once under concurrency so two workers can
  // never double-spend a mission limit or duplicate a delegated allocation.
  putMissionBudget(record: MissionBudgetRecord): Promise<void>
  getMissionBudget(missionID: string): Promise<MissionBudgetRecord | undefined>
  // Atomically consume one model call against the mission hard limit (the
  // record's own max_model_calls). Returns false and flags hard_reached when
  // the limit is reached. Never fails a task in a half-mutated state: the
  // caller checks the result before acting.
  atomicTryConsumeMissionCall(missionID: string): Promise<boolean>
  // Add tokens to the mission usage; returns the new token count.
  atomicAddMissionTokens(missionID: string, tokens: number): Promise<number>
  // Raise mission limits (human-approved budget increase); clears hard_reached.
  atomicRaiseMissionLimits(missionID: string, increase: Partial<MissionBudgetRecord>): Promise<void>
  // Seed or overwrite an agent's delegation record (primary pool at mission
  // start; child allocations created by delegation).
  atomicSeedAgentBudget(record: AgentBudgetRecord): Promise<void>
  // Atomically move budget from the parent's remaining to a new child
  // allocation. No partial transfers: any shortfall rejects the delegation.
  atomicDelegateChildBudget(missionID: string, parentID: string, childID: string, amount: ChildBudgetAmount): Promise<{ ok: true } | { ok: false; code: "parent_budget_exhausted" | "no_parent_allocation" }>
  // Return a child's unused allocation to its parent.
  atomicReclaimChildBudget(missionID: string, childID: string): Promise<void>
  // Atomically consume from an agent's own allocation (its delegated share).
  atomicTryConsumeAgentBudget(agentID: string, calls?: number, tokens?: number, cost?: number): Promise<boolean>
  atomicAgentBudgetRemaining(agentID: string): Promise<ChildBudgetAmount | undefined>
  missionAccounting(missionID: string): Promise<MissionAccounting | undefined>

  snapshot(): Promise<StoreSnapshot>
}
