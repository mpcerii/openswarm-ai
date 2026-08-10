export * as SwarmApproval from "./approval"

import { Schema } from "effect"
import { ascending } from "@opencode-ai/schema/identifier"
import { optional, DateTimeUtcFromMillis, statics } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"

export const ID = Schema.String.check(Schema.isStartsWith("swp_")).pipe(
  Schema.brand("SwarmApproval.ID"),
  statics((schema) => ({ create: () => schema.make("swp_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Action = Schema.Literals([
  "spawn",
  "workspace_write",
  "dependency_change",
  "git_commit",
  "git_push",
  "merge",
  "external_side_effect",
]).annotate({ identifier: "SwarmApproval.Action" })
export type Action = typeof Action.Type

// Mirrors OpenCode permission vocabulary so approvals evaluate through the
// existing permission engine.
export const Effect = Schema.Literals(["allow", "ask", "deny"]).annotate({
  identifier: "SwarmApproval.Effect",
})
export type Effect = typeof Effect.Type

export const Reply = Schema.Literals(["once", "always", "reject"]).annotate({
  identifier: "SwarmApproval.Reply",
})
export type Reply = typeof Reply.Type

export interface Request extends Schema.Schema.Type<typeof Request> {}
export const Request = Schema.Struct({
  id: ID,
  agentID: SwarmAgent.ID,
  action: Action,
  summary: Schema.String,
  metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "SwarmApproval.Request" })
