export * as SwarmIdempotency from "./idempotency"

import { Schema } from "effect"
import { ascending } from "@opencode-ai/schema/identifier"
import { NonNegativeInt, optional, DateTimeUtcFromMillis, statics } from "@opencode-ai/schema/schema"
import { SwarmWorker } from "./worker"

// Idempotency ledger. Every side-effecting operation a worker performs
// (running an agent, creating an artifact, pushing a patch) registers an
// operation keyed by (kind, key). Retries reuse the same key: if the ledger
// already has a completed entry the effect is skipped, so a retried run can
// never create the same PR twice, push twice, apply a patch twice, run a
// migration twice, or spawn duplicate work.

export const ID = Schema.String.check(Schema.isStartsWith("swx_")).pipe(
  Schema.brand("SwarmIdempotency.ID"),
  statics((schema) => ({ create: () => schema.make("swx_" + ascending()) })),
)
export type ID = typeof ID.Type

export type Kind = "agent.run" | "artifact.create" | "finding.cluster" | "approval.request" | "task.create"

export interface Record {
  id: string
  kind: Kind
  op_key: string
  // JSON-encoded result produced by the completed operation. Replayed to a
  // retrying worker so it can skip re-execution.
  result: string | null
  claimed_by: string | null
  created_at: number
  completed_at: number | null
}

export interface Op {
  readonly kind: Kind
  readonly key: string
  readonly claimedBy?: string
  readonly time: number
}

export function make(op: Op): Record {
  return {
    id: ID.create(),
    kind: op.kind,
    op_key: op.key,
    result: null,
    claimed_by: op.claimedBy ?? null,
    created_at: op.time,
    completed_at: null,
  }
}

// Composite key used for the agent-run op: stable across retries of the same
// run number, unique per run number so a fresh run always re-executes.
export function agentRunKey(agentID: string, runNumber: number): string {
  return `agent:${agentID}:${runNumber}`
}

export function artifactKey(agentID: string, contentRef: string): string {
  return `artifact:${agentID}:${contentRef}`
}

export function isPending(r: Record): boolean {
  return r.completed_at === null
}

export function touchedBy(r: Record): string | null {
  return r.claimed_by
}
