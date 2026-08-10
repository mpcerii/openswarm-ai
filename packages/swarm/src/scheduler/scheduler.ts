export * as SwarmScheduler from "./scheduler"

import { Schema } from "effect"
import { optional } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"

export const Decision = Schema.Literals(["admit", "queue"]).annotate({
  identifier: "SwarmScheduler.Decision",
})
export type Decision = typeof Decision.Type

export interface Admission extends Schema.Schema.Type<typeof Admission> {}
export const Admission = Schema.Struct({
  agentID: SwarmAgent.ID,
  decision: Decision,
  reason: optional(Schema.String),
}).annotate({ identifier: "SwarmScheduler.Admission" })
