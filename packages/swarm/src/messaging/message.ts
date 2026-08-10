export * as SwarmMessage from "./message"

import { Schema } from "effect"
import { ascending } from "@opencode-ai/schema/identifier"
import { optional, DateTimeUtcFromMillis, statics } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"

export const ID = Schema.String.check(Schema.isStartsWith("swm_")).pipe(
  Schema.brand("SwarmMessage.ID"),
  statics((schema) => ({ create: () => schema.make("swm_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Sender = Schema.Union([SwarmAgent.ID, Schema.Literals(["human", "primary"])]).annotate({
  identifier: "SwarmMessage.Sender",
})
export type Sender = typeof Sender.Type

// Mirrors OpenCode SessionInput delivery vocabulary: "steer" promotes at the
// next safe provider-turn boundary, "queue" waits until the session is idle.
export const Delivery = Schema.Literals(["steer", "queue"]).annotate({
  identifier: "SwarmMessage.Delivery",
})
export type Delivery = typeof Delivery.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  from: Sender,
  to: SwarmAgent.ID,
  delivery: Delivery,
  body: Schema.String,
  inReplyTo: optional(ID),
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "SwarmMessage.Info" })
