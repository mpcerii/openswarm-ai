import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

// ---------------------------------------------------------------------------
// Swarm HttpApi: real swarm runtime state exposed to the TUI / CLI. Reads from
// the live SwarmService (the durable store the running instance writes to), so
// `/swarm` in the TUI shows REAL state — never fake/demo data.
// ---------------------------------------------------------------------------

export const SwarmModelState = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  available: Schema.Boolean,
}).annotate({ identifier: "SwarmModelState" })

export const SwarmStatusResponse = Schema.Struct({
  enabled: Schema.Boolean,
  models: Schema.Struct({
    allowed: Schema.Array(Schema.String),
    approved: NonNegativeInt,
  }),
  modelStates: Schema.Array(SwarmModelState),
  population: Schema.Struct({
    current: NonNegativeInt,
    max: NonNegativeInt,
  }),
  active: Schema.Struct({
    agents: NonNegativeInt,
    max: NonNegativeInt,
    llm: NonNegativeInt,
    peak: NonNegativeInt,
  }),
  workspaces: Schema.Struct({
    active: NonNegativeInt,
    max: NonNegativeInt,
  }),
  agentsByState: Schema.Record(Schema.String, NonNegativeInt),
  agentsTotal: NonNegativeInt,
  errors: Schema.Array(Schema.String),
}).annotate({ identifier: "SwarmStatus" })

export const SwarmAgentListItem = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  role: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  mission: Schema.String,
}).annotate({ identifier: "SwarmAgentListItem" })

export const SwarmAgentsResponse = Schema.Struct({
  agents: Schema.Array(SwarmAgentListItem),
}).annotate({ identifier: "SwarmAgents" })

export const SwarmCancelInput = Schema.Struct({
  agentID: Schema.String,
  // When true, cancels the agent and its whole descendant subtree.
  branch: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "SwarmCancelInput" })

export const SwarmCancelResponse = Schema.Struct({
  cancelled: Schema.Array(Schema.String),
}).annotate({ identifier: "SwarmCancelResponse" })

export const SwarmReleaseWorktreeInput = Schema.Struct({
  agentID: Schema.String,
}).annotate({ identifier: "SwarmReleaseWorktreeInput" })

export const SwarmProvenanceEntry = Schema.Struct({
  file: Schema.String,
  agentID: Schema.String,
  role: Schema.optional(Schema.String),
  state: Schema.String,
  taskID: Schema.optional(Schema.String),
  artifacts: Schema.Array(Schema.String),
  workspacePath: Schema.optional(Schema.String),
}).annotate({ identifier: "SwarmProvenanceEntry" })

export const SwarmProvenanceResponse = Schema.Struct({
  entries: Schema.Array(SwarmProvenanceEntry),
}).annotate({ identifier: "SwarmProvenance" })

export const SwarmIntegrationApproveInput = Schema.Struct({
  summary: Schema.String,
  changedFiles: Schema.Array(Schema.String),
  sessionID: Schema.String,
}).annotate({ identifier: "SwarmIntegrationApproveInput" })

export const SwarmIntegrationApproveResponse = Schema.Struct({
  approved: Schema.Boolean,
  reason: Schema.optional(Schema.String),
}).annotate({ identifier: "SwarmIntegrationApprove" })

export const SwarmIntegrationApplyResponse = Schema.Struct({
  applied: Schema.Boolean,
  changedFiles: Schema.Array(Schema.String),
  reason: Schema.optional(Schema.String),
}).annotate({ identifier: "SwarmIntegrationApply" })

export const SwarmPaths = {
  status: "/swarm/status",
  agents: "/swarm/agents",
  pause: "/swarm/pause",
  resume: "/swarm/resume",
  cancel: "/swarm/cancel",
  releaseWorktree: "/swarm/release-worktree",
  why: "/swarm/why",
  integrationApprove: "/swarm/integration/approve",
  integrationApply: "/swarm/integration/apply",
} as const

export const SwarmApi = HttpApi.make("swarm")
  .add(
    HttpApiGroup.make("swarm")
      .add(
        HttpApiEndpoint.get("status", SwarmPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(SwarmStatusResponse, "Swarm status"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "swarm.status.get",
            summary: "Get swarm runtime status",
            description: "Get live swarm scheduler state: population, active bounds, approved models, per-state counts.",
          }),
        ),
        HttpApiEndpoint.get("agents", SwarmPaths.agents, {
          query: WorkspaceRoutingQuery,
          success: described(SwarmAgentsResponse, "Swarm agents"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "swarm.agents.list",
            summary: "List swarm agents",
            description: "List logical swarm agents with their current states.",
          }),
        ),
        HttpApiEndpoint.post("pause", SwarmPaths.pause, {
          query: WorkspaceRoutingQuery,
          success: described(SwarmStatusResponse, "Swarm paused"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "swarm.pause.post",
            summary: "Pause swarm scheduling",
            description: "Stop scheduling new agents and starting new model calls. Durable queued state is preserved.",
          }),
        ),
        HttpApiEndpoint.post("resume", SwarmPaths.resume, {
          query: WorkspaceRoutingQuery,
          success: described(SwarmStatusResponse, "Swarm resumed"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "swarm.resume.post",
            summary: "Resume swarm scheduling",
            description: "Resume the scheduler from durable state.",
          }),
        ),
        HttpApiEndpoint.post("cancel", SwarmPaths.cancel, {
          query: WorkspaceRoutingQuery,
          payload: SwarmCancelInput,
          success: described(SwarmCancelResponse, "Cancelled agents"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "swarm.cancel.post",
            summary: "Cancel an agent (or a subtree)",
            description: "Cancel a single agent or, with branch=true, the whole descendant subtree. Releases sessions and worktrees; preserves history.",
          }),
        ),
        HttpApiEndpoint.post("releaseWorktree", SwarmPaths.releaseWorktree, {
          query: WorkspaceRoutingQuery,
          payload: SwarmReleaseWorktreeInput,
          success: described(SwarmStatusResponse, "Worktree released"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "swarm.releaseWorktree.post",
            summary: "Release an agent's worktree",
            description: "Release the git worktree allocated to an agent after its patch data has been captured.",
          }),
        ),
        HttpApiEndpoint.get("why", SwarmPaths.why, {
          query: { ...WorkspaceRoutingQuery.fields, target: Schema.String },
          success: described(SwarmProvenanceResponse, "Swarm provenance"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "swarm.why.get",
            summary: "Get swarm provenance (/why)",
            description:
              "Return stored operational provenance for a file path or agent id: which agents touched it, their tasks, patches, and reviews.",
          }),
        ),
        HttpApiEndpoint.post("integrationApprove", SwarmPaths.integrationApprove, {
          query: WorkspaceRoutingQuery,
          payload: SwarmIntegrationApproveInput,
          success: described(SwarmIntegrationApproveResponse, "Integration approved"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "swarm.integration.approve",
            summary: "Approve swarm integration",
            description:
              "Raise a real permission prompt for integrating accepted patches into the user's working tree. Server-side enforced: no approval token means apply is rejected.",
          }),
        ),
        HttpApiEndpoint.post("integrationApply", SwarmPaths.integrationApply, {
          query: WorkspaceRoutingQuery,
          success: described(SwarmIntegrationApplyResponse, "Integration applied"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "swarm.integration.apply",
            summary: "Apply approved integration",
            description:
              "Apply the approved patch set to the working tree. Rejects unless a server-side integration approval exists — never trusts a client boolean.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "swarm",
          description: "openSwarm runtime status routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode swarm HttpApi",
      version: "0.0.1",
      description: "openSwarm runtime status surface.",
    }),
  )