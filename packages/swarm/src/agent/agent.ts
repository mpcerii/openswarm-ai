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

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  parent: optional(Parent),
  // Roles are arbitrary runtime metadata chosen per mission, not fixed tiers.
  role: optional(Schema.String),
  state: State,
  mission: Schema.String,
  // Requested "provider/model"; must be admitted by SwarmModels.ModelPolicy before use.
  model: optional(Schema.String),
  // OpenCode session backing the agent while it executes.
  sessionID: optional(SessionID),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "SwarmAgent.Info" })

export interface SpawnRequest extends Schema.Schema.Type<typeof SpawnRequest> {}
export const SpawnRequest = Schema.Struct({
  parentAgentID: optional(ID),
  mission: Schema.String,
  role: optional(Schema.String),
  model: optional(Schema.String),
  count: optional(PositiveInt),
  metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "SwarmAgent.SpawnRequest" })

export const RejectionCode = Schema.Literals([
  "swarm_disabled",
  "population_exceeded",
  "depth_exceeded",
  "children_exceeded",
  "model_not_allowed",
  "no_models_allowed",
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
