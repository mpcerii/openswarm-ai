export * as SwarmWorkspace from "./workspace"

import { Schema } from "effect"
import { AbsolutePath, optional } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"

export const Kind = Schema.Literals(["in_place", "worktree"]).annotate({
  identifier: "SwarmWorkspace.Kind",
})
export type Kind = typeof Kind.Type

export const State = Schema.Literals(["pending", "allocated", "released"]).annotate({
  identifier: "SwarmWorkspace.State",
})
export type State = typeof State.Type

// Workspaces are allocated lazily to executing agents only; logical
// population never owns per-agent worktrees.
export interface Allocation extends Schema.Schema.Type<typeof Allocation> {}
export const Allocation = Schema.Struct({
  agentID: SwarmAgent.ID,
  kind: Kind,
  state: State,
  path: optional(AbsolutePath),
  branch: optional(Schema.String),
}).annotate({ identifier: "SwarmWorkspace.Allocation" })
