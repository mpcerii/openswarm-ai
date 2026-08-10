export * as SwarmTask from "./task"

import { Schema } from "effect"
import { ascending } from "@opencode-ai/schema/identifier"
import { optional, DateTimeUtcFromMillis, statics } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"

export const ID = Schema.String.check(Schema.isStartsWith("swt_")).pipe(
  Schema.brand("SwarmTask.ID"),
  statics((schema) => ({ create: () => schema.make("swt_" + ascending()) })),
)
export type ID = typeof ID.Type

export const State = Schema.Literals([
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]).annotate({ identifier: "SwarmTask.State" })
export type State = typeof State.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  agentID: SwarmAgent.ID,
  parentID: optional(ID),
  title: Schema.String,
  description: optional(Schema.String),
  state: State,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "SwarmTask.Info" })
