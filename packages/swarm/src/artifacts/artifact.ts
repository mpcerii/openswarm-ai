export * as SwarmArtifact from "./artifact"

import { Schema, DateTime } from "effect"
import { ascending } from "@opencode-ai/schema/identifier"
import { optional, DateTimeUtcFromMillis, statics, NonNegativeInt } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"
import { SwarmTask } from "../task/task"

export const ID = Schema.String.check(Schema.isStartsWith("swf_")).pipe(
  Schema.brand("SwarmArtifact.ID"),
  statics((schema) => ({ create: () => schema.make("swf_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Kind = Schema.Literals(["patch", "branch", "worktree", "file", "text", "census"]).annotate({
  identifier: "SwarmArtifact.Kind",
})
export type Kind = typeof Kind.Type

// Patch bodies are the canonical unit of integration. The kernel never asks
// a worker to merge directly into a protected branch: the worker produces
// this Patch and the kernel routes it through review swarm + approval gate.
export interface PatchBody extends Schema.Schema.Type<typeof PatchBody> {}
export const PatchBody = Schema.Struct({
  baseCommit: Schema.String,
  changedFiles: Schema.Array(Schema.String),
  // Unified-diff text OR a serialized snapshot reference. Either way the
  // integration layer produces a single reconciled set of file edits.
  diff: Schema.String,
  testsExecuted: Schema.Array(Schema.String),
  // "pass" | "fail" | "skipped" per command listed above. Same index order.
  testResults: Schema.Array(Schema.Literals(["pass", "fail", "skipped"])),
  // Free-form human/agent rationale surfaced in /why.
  reason: Schema.String,
  // Token accounting summary from the worker session; used by the
  // integration approval preview, not for billing.
  tokensUsed: NonNegativeInt,
}).annotate({ identifier: "SwarmArtifact.PatchBody" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  agentID: SwarmAgent.ID,
  taskID: optional(SwarmTask.ID),
  kind: Kind,
  ref: Schema.String,
  summary: optional(Schema.String),
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "SwarmArtifact.Info" })

// Runtime extension. The kernel stores the Patch body verbatim in-process;
// durable persistence later references it via artifactID in the audit log.
export interface PatchRecord {
  readonly artifact: Info
  readonly patch: PatchBody
  // Reviews linked to this artifact so isAcceptable can run without a join.
  reviews: import("../review/review").SwarmReview.Info[]
  // Reconciliation state set by the integration layer.
  state: "proposed" | "reviewed" | "approved" | "rejected" | "integrated"
}

export interface BuildOptions {
  readonly agentID: SwarmAgent.ID
  readonly taskID?: SwarmTask.ID
  readonly kind: Kind
  readonly patch: PatchBody
  readonly summary?: string
  readonly time: number
}

export function buildPatchArtifact(opts: BuildOptions): PatchRecord {
  const artifact: Info = {
    id: ID.create(),
    agentID: opts.agentID,
    taskID: opts.taskID,
    kind: opts.kind,
    ref: `patch:${opts.patch.baseCommit.slice(0, 12)}`,
    summary: opts.summary,
    time: DateTime.makeUnsafe(opts.time),
  }
  return { artifact, patch: opts.patch, reviews: [], state: "proposed" }
}