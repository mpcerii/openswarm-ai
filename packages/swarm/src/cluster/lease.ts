export * as SwarmLease from "./lease"

import { Schema } from "effect"
import { ascending } from "@opencode-ai/schema/identifier"
import { NonNegativeInt, optional, DateTimeUtcFromMillis, statics } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"
import { SwarmWorker } from "./worker"

// A work lease grants a single worker the right to execute one agent run.
// Leases are NOT permanent assignments: a worker that disappears before
// completing simply lets the lease expire and the agent becomes eligible
// again. The lease record is the authority for "who may run this right now".

export const ID = Schema.String.check(Schema.isStartsWith("swl_")).pipe(
  Schema.brand("SwarmLease.ID"),
  statics((schema) => ({ create: () => schema.make("swl_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Status = Schema.Literals([
  "pending",
  "claimed",
  "executing",
  "completing",
  "completed",
  "failed",
  "expired",
]).annotate({ identifier: "SwarmLease.Status" })
export type Status = typeof Status.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  agentID: SwarmAgent.ID,
  workerID: optional(SwarmWorker.ID),
  // Which run attempt of the agent this lease covers (ties into the
  // idempotency ledger so a retry reuses the same operation key).
  runNumber: NonNegativeInt,
  status: Status,
  issuedAt: DateTimeUtcFromMillis,
  lastHeartbeat: DateTimeUtcFromMillis,
  expiresAt: DateTimeUtcFromMillis,
  attempts: NonNegativeInt,
  // Idempotency key for this agent run, set by the control plane at issue.
  opKey: Schema.String,
}).annotate({ identifier: "SwarmLease.Info" })

// Durable row shape. `result` holds the JSON-encoded completion payload.
export interface Record {
  id: string
  agent_id: string
  worker_id: string | null
  run_number: number
  status: Status
  issued_at: number
  last_heartbeat: number
  expires_at: number
  attempts: number
  op_key: string
  result: string | null
  created_at: number
  // Whether the executing worker reserved a global LLM slot for this run. The
  // control plane releases leaked slots on lease expiry so a dead worker
  // cannot permanently exhaust the global LLM concurrency budget.
  llm_reserved: boolean
}

export type Issue = {
  readonly id: ID
  readonly agentID: SwarmAgent.ID
  readonly runNumber: number
  readonly issuedAt: number
  readonly expiresAt: number
  readonly attempts: number
  readonly opKey: string
}

export function make(opts: Issue): Record {
  return {
    id: opts.id,
    agent_id: opts.agentID,
    worker_id: null,
    run_number: opts.runNumber,
    status: "pending",
    issued_at: opts.issuedAt,
    last_heartbeat: opts.issuedAt,
    expires_at: opts.expiresAt,
    attempts: opts.attempts,
    op_key: opts.opKey,
    result: null,
    created_at: opts.issuedAt,
    llm_reserved: false,
  }
}

export function isActive(status: Status): boolean {
  return status === "pending" || status === "claimed" || status === "executing" || status === "completing"
}
