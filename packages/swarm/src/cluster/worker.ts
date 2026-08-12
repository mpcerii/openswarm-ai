export * as SwarmWorker from "./worker"

import { Schema, DateTime } from "effect"
import { ascending } from "@opencode-ai/schema/identifier"
import { NonNegativeInt, PositiveInt, optional, DateTimeUtcFromMillis, statics } from "@opencode-ai/schema/schema"

// A worker is an independent execution engine that claims leases from the
// control plane and runs agents. Workers are disposable: a logical agent is
// NOT bound to any worker, so agent identity and durable state live on the
// control plane's store, never in the worker process.

export const ID = Schema.String.check(Schema.isStartsWith("swk_")).pipe(
  Schema.brand("SwarmWorker.ID"),
  statics((schema) => ({ create: () => schema.make("swk_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Platform = Schema.Literals(["linux", "darwin", "win32", "freebsd", "other"]).annotate({
  identifier: "SwarmWorker.Platform",
})
export type Platform = typeof Platform.Type

// Health as observed by the control plane. Heartbeats move a worker between
// healthy/busy; draining is human-initiated; offline/unhealthy are detected
// by heartbeat timeout.
export const Health = Schema.Literals(["healthy", "busy", "draining", "offline", "unhealthy"]).annotate({
  identifier: "SwarmWorker.Health",
})
export type Health = typeof Health.Type

export interface Capabilities extends Schema.Schema.Type<typeof Capabilities> {}
export const Capabilities = Schema.Struct({
  workerID: ID,
  // Bounded concurrency ceilings enforced by the control plane per worker.
  maxConcurrentAgents: PositiveInt,
  maxConcurrentTools: optional(PositiveInt),
  // Platforms this node can execute on.
  supportedPlatforms: Schema.Array(Platform),
  // Free-form capability tags: e.g. "docker", "sandbox", "coding-workspace",
  // "review", "migration". The scheduler routes agents whose required
  // capabilities are a subset of this set.
  capabilities: Schema.Array(Schema.String),
  // "provider/model" ids this node can actually serve. Empty = inherits the
  // control-plane model allowlist (human allowlist ∩ availability = the
  // worker's effective set). A worker may NOT broaden the human allowlist.
  availableModels: Schema.Array(Schema.String),
  git: Schema.Boolean,
  shell: Schema.Boolean,
  sandbox: Schema.Boolean,
  labels: optional(Schema.Record(Schema.String, Schema.String)),
}).annotate({ identifier: "SwarmWorker.Capabilities" })

export interface Registration extends Schema.Schema.Type<typeof Registration> {}
export const Registration = Schema.Struct({
  workerID: ID,
  name: Schema.String,
  capabilities: Capabilities,
  // Credential id issued to this worker. Remote registration MUST present the
  // matching secret; anonymous remote workers are rejected by default.
  credentialID: optional(Schema.String),
  version: optional(Schema.String),
}).annotate({ identifier: "SwarmWorker.Registration" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  name: Schema.String,
  capabilities: Capabilities,
  health: Health,
  lastHeartbeat: DateTimeUtcFromMillis,
  registeredAt: DateTimeUtcFromMillis,
  // Set by the control plane when the worker declared drain and finished its
  // leases, or when it was detected offline.
  offlineAt: optional(DateTimeUtcFromMillis),
  // Cumulative lease counters for observability.
  leasesTotal: NonNegativeInt,
  leasesFailed: NonNegativeInt,
  credentialID: optional(Schema.String),
}).annotate({ identifier: "SwarmWorker.Info" })

// Durable row shape stored on the control plane. `capabilities` and `labels`
// are JSON-encoded strings in SQLite.
export interface Record {
  id: string
  name: string
  capabilities: Capabilities
  health: Health
  last_heartbeat: number
  registered_at: number
  offline_at: number | null
  leases_total: number
  leases_failed: number
  credential_id: string | null
}

export interface RegisterResult {
  readonly workerID: ID
  readonly accepted: boolean
  readonly reason?: string
}

export function infoFromRecord(r: Record): Info {
  return {
    id: r.id as ID,
    name: r.name,
    capabilities: r.capabilities,
    health: r.health,
    lastHeartbeat: DateTime.makeUnsafe(r.last_heartbeat),
    registeredAt: DateTime.makeUnsafe(r.registered_at),
    offlineAt: r.offline_at === null ? undefined : DateTime.makeUnsafe(r.offline_at),
    leasesTotal: r.leases_total,
    leasesFailed: r.leases_failed,
    credentialID: r.credential_id === null ? undefined : r.credential_id,
  }
}

// A worker is eligible to execute an agent when its health allows new leases,
// it is not draining, it covers the agent's required capabilities, and the
// agent's resolved model is available. Model availability never broadens the
// human allowlist — resolution already happened on the control plane.
export function canRun(worker: Record, requiredCaps: ReadonlyArray<string>, model: string | undefined): boolean {
  if (worker.health === "draining") return false
  if (worker.health !== "healthy" && worker.health !== "busy") return false
  const caps = worker.capabilities
  for (const cap of requiredCaps) {
    if (!caps.capabilities.includes(cap)) return false
  }
  if (model !== undefined && caps.availableModels.length > 0 && !caps.availableModels.includes(model)) return false
  return true
}

// Per-worker concurrency ceiling. The control plane never hands a worker more
// concurrent leases than its declared max.
export function atCapacity(worker: Record, activeLeases: number): boolean {
  return activeLeases >= worker.capabilities.maxConcurrentAgents
}
