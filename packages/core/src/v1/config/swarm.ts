export * as ConfigSwarmV1 from "./swarm"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, type DeepMutable } from "../../schema"

export const ApprovalAction = Schema.Literals(["allow", "ask", "deny"]).annotate({
  identifier: "SwarmApprovalAction",
  description: "Approval effect evaluated through the openSwarm permission engine",
})

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable the openSwarm multi-agent layer. When false (default), swarm tools are not registered and behavior matches upstream openSwarm.",
  }),
  max_agents: Schema.optional(PositiveInt).annotate({
    description:
      "Maximum logical swarm agent population. Agents are lightweight durable records, not processes. Defaults to 10000.",
  }),
  max_active_agents: Schema.optional(PositiveInt).annotate({
    description: "Maximum number of swarm agents executing concurrently. Defaults to 32.",
  }),
  max_depth: Schema.optional(NonNegativeInt).annotate({
    description: "Maximum spawn depth below the primary agent. Defaults to 12.",
  }),
  max_children_per_agent: Schema.optional(NonNegativeInt).annotate({
    description: "Maximum direct children a single agent may spawn. Defaults to 500.",
  }),
  models: Schema.optional(
    Schema.Struct({
      allowed: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description:
          'Exact "provider/model" identifiers swarm agents may use. An empty list means swarm agents may use NO models (fail-closed); it never grants all configured models.',
      }),
    }),
  ).annotate({
    description: "Model policy for swarm agents. The runtime enforces this allowlist; agents cannot bypass it.",
  }),
  approval: Schema.optional(
    Schema.Struct({
      spawn: Schema.optional(ApprovalAction),
      workspace_write: Schema.optional(ApprovalAction),
      dependency_change: Schema.optional(ApprovalAction),
      git_commit: Schema.optional(ApprovalAction),
      git_push: Schema.optional(ApprovalAction),
      merge: Schema.optional(ApprovalAction),
      external_side_effect: Schema.optional(ApprovalAction),
    }),
  ).annotate({
    description:
      "Approval policy for swarm agents. Values map onto openSwarm permission rules; existing permission semantics are preserved.",
  }),
}).annotate({ identifier: "SwarmConfig" })

export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>
