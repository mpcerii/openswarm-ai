export * as SwarmArtifact from "./artifact"

import { Schema } from "effect"
import { ascending } from "@opencode-ai/schema/identifier"
import { optional, DateTimeUtcFromMillis, statics } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"
import { SwarmTask } from "../task/task"

export const ID = Schema.String.check(Schema.isStartsWith("swf_")).pipe(
  Schema.brand("SwarmArtifact.ID"),
  statics((schema) => ({ create: () => schema.make("swf_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Kind = Schema.Literals(["patch", "branch", "worktree", "file", "text"]).annotate({
  identifier: "SwarmArtifact.Kind",
})
export type Kind = typeof Kind.Type

// Artifacts reference existing OpenCode storage: snapshot patch hashes,
// git branches, managed worktrees, files, or task result text. No new
// storage engine.
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
