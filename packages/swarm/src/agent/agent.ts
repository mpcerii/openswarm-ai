export * as SwarmAgent from "./agent"

import { Schema } from "effect"
import { ascending } from "@opencode-ai/schema/identifier"
import { NonNegativeInt, PositiveInt, optional, DateTimeUtcFromMillis, statics } from "@opencode-ai/schema/schema"
import { SessionID } from "@opencode-ai/schema/session-id"

export const ID = Schema.String.check(Schema.isStartsWith("swa_")).pipe(
  Schema.brand("SwarmAgent.ID"),
  statics((schema) => ({ create: () => schema.make("swa_" + ascending()) })),
)
export type ID = typeof ID.Type

export const State = Schema.Literals([
  "created",
  "queued",
  "running",
  "waiting",
  "sleeping",
  "blocked",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "retired",
]).annotate({ identifier: "SwarmAgent.State" })
export type State = typeof State.Type

export interface Parent extends Schema.Schema.Type<typeof Parent> {}
export const Parent = Schema.Struct({
  agentID: ID,
  depth: NonNegativeInt,
}).annotate({ identifier: "SwarmAgent.Parent" })

// Budget delegated to an agent: local population accounting. Children can
// never mint capacity — only the runtime transfers credits between records.
export interface Budget extends Schema.Schema.Type<typeof Budget> {}
export const Budget = Schema.Struct({
  spawnCredits: NonNegativeInt,
  tokenLimit: optional(PositiveInt),
  costLimit: optional(Schema.Number),
}).annotate({ identifier: "SwarmAgent.Budget" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  // Hierarchical placement (set once at creation; immutable).
  rootID: ID,
  parent: optional(Parent),
  depth: NonNegativeInt,
  // Roles are arbitrary runtime metadata chosen per mission, not fixed tiers.
  role: optional(Schema.String),
  state: State,
  mission: Schema.String,
  // Requested "provider/model"; must be admitted by SwarmModels.ModelPolicy
  // before use, and the model the runtime actually resolved.
  model: optional(Schema.String),
  resolvedModel: optional(Schema.String),
  // openSwarm session backing the agent while it executes (absent when idle).
  sessionID: optional(SessionID),
  // Spawn credits delegated to this agent by its parent (for recursive spawn).
  spawnCredits: NonNegativeInt,
  budget: optional(Budget),
  // Tasks owned by this agent (provenance: mission -> task -> agent).
  taskIDs: optional(Schema.Array(Schema.String)),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "SwarmAgent.Info" })

// `AgentRecord` is the durable, DB-shaped projection of an agent — the single
// source of truth for reconstructing an agent across process restarts. The
// encoded shape mirrors `Info` field-for-field; encoded form is produced by
// the SwarmRegistry persistence layer (see ./schema.ts row interfaces).
export type AgentRecord = Schema.Schema.Type<typeof Info>

export interface SpawnRequest extends Schema.Schema.Type<typeof SpawnRequest> {}
export const SpawnRequest = Schema.Struct({
  parentAgentID: optional(ID),
  mission: Schema.String,
  role: optional(Schema.String),
  model: optional(Schema.String),
  capability: optional(Schema.String),
  // Semantic pool the agent requests; the router intersects it with the
  // human allowlist (fail-closed). Never auto-populated by the caller.
  pool: optional(Schema.String),
  // Expected context the agent needs; the router never selects a model whose
  // window is smaller (compact/split or reject instead of truncating).
  context_size: optional(NonNegativeInt),
  requires_tools: optional(Schema.Boolean),
  priority: optional(Schema.Number),
  budget: optional(
    Schema.Struct({
      spawnCredits: optional(NonNegativeInt),
      tokenLimit: optional(PositiveInt),
      costLimit: optional(Schema.Number),
    }),
  ),
  count: optional(PositiveInt),
  metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "SwarmAgent.SpawnRequest" })

export const RejectionCode = Schema.Literals([
  "swarm_disabled",
  "population_exceeded",
  "depth_exceeded",
  "children_exceeded",
  "credits_exhausted",
  "model_not_allowed",
  "no_models_allowed",
  "pool_empty",
  "no_eligible_model",
  "context_overflow",
  "no_remaining_budget",
  "budget_exhausted",
]).annotate({ identifier: "SwarmAgent.RejectionCode" })
export type RejectionCode = typeof RejectionCode.Type

export interface Spawned extends Schema.Schema.Type<typeof Spawned> {}
export const Spawned = Schema.Struct({
  type: Schema.Literal("spawned"),
  agents: Schema.Array(ID),
}).annotate({ identifier: "SwarmAgent.Spawned" })

export interface Rejected extends Schema.Schema.Type<typeof Rejected> {}
export const Rejected = Schema.Struct({
  type: Schema.Literal("rejected"),
  code: RejectionCode,
  message: Schema.String,
}).annotate({ identifier: "SwarmAgent.Rejected" })

export type SpawnResult = typeof SpawnResult.Type
export const SpawnResult = Schema.Union([Spawned, Rejected]).annotate({ identifier: "SwarmAgent.SpawnResult" })

// ---------------------------------------------------------------------------
// State machine. The runtime is the only thing that mutates agent state, and
// only through these legal transitions. Illegal transitions throw so the
// bug surfaces in tests instead of silently corrupting the audit log.
// ---------------------------------------------------------------------------

const TRANSITIONS: Readonly<Record<State, ReadonlySet<State>>> = Object.freeze({
  created: new Set<State>(["queued", "cancelled", "failed"]),
  queued: new Set<State>(["running", "cancelled", "blocked"]),
  running: new Set<State>(["waiting", "sleeping", "blocked", "awaiting_approval", "completed", "failed", "cancelled"]),
  waiting: new Set<State>(["queued", "running", "completed", "failed", "cancelled"]),
  sleeping: new Set<State>(["running", "cancelled"]),
  blocked: new Set<State>(["queued", "cancelled", "failed"]),
  awaiting_approval: new Set<State>(["running", "queued", "blocked", "cancelled", "failed"]),
  completed: new Set<State>(["retired"]),
  failed: new Set<State>(["queued", "retired", "cancelled"]),
  cancelled: new Set<State>(["retired"]),
  retired: new Set<State>([]),
}) as Readonly<Record<State, ReadonlySet<State>>>

export function canTransition(from: State, to: State): boolean {
  return TRANSITIONS[from].has(to)
}

export function transition(from: State, to: State): State {
  if (!canTransition(from, to)) throw new Error(`Illegal agent state transition: ${from} -> ${to}`)
  return to
}

// Terminal states never produce further transitions. The scheduler prunes
// these when re-scanning the queue.
export function isTerminal(state: State): boolean {
  return state === "retired"
}

// Lifecycle indicator separate from terminal: terminal-like done states that
// no longer consume active slots, but the record may remain until retired.
export function isDone(state: State): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "retired"
}

// ---------------------------------------------------------------------------
// Runtime record. Extends the wire Info with mutable bookkeeping the kernel
// uses for scheduling, retries, and provenance. Stored in-process by the
// runtime; never serialized on the durable event stream.
// ---------------------------------------------------------------------------

export interface RuntimeRecord {
  readonly info: Info
  // Monotonic counters used by the scheduler & recovery.
  attempts: number
  failures: number
  // Last readable failure reason for `/why` provenance & audit log.
  lastError: string | undefined
  // Optional workspace path allocated to this agent. Set/cleared by the
  // WorkspaceManager. Only present for agents that actually modify files.
  workspacePath: string | undefined
  // Optional lease IDs held by this agent (conflict control). One entry per
  // affected area.
  leases: Set<string>
  // Pending inbound message ids (mailbox queue). Drained atomically when the
  // agent transitions to running.
  pendingMessages: string[]
  // Cap set by the spawn request; agents may choose any subset of their
  // parent's caps. Children may not exceed parent caps.
  caps: ReadonlySet<string>
  // Higher = more expensive model; used for budget considerations. Soft.
  costPriority: number
}

export function makeRuntimeRecord(info: Info, opts: { caps?: ReadonlySet<string>; costPriority?: number } = {}): RuntimeRecord {
  return {
    info,
    attempts: 0,
    failures: 0,
    lastError: undefined,
    workspacePath: undefined,
    leases: new Set(),
    pendingMessages: [],
    caps: opts.caps ?? new Set<string>(),
    costPriority: opts.costPriority ?? 0,
  }
}
