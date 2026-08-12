export * as SwarmEvents from "./events"

import { Schema } from "effect"
import { Event } from "@opencode-ai/schema/event"
import { optional } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"
import { SwarmApproval } from "../approvals/approval"
import { SwarmTask } from "../task/task"
import { SwarmArtifact } from "../artifacts/artifact"
import { SwarmWorkspace } from "../workspace/workspace"
import { SwarmReview } from "../review/review"
import { SwarmDedup } from "../dedup/dedup"
import { SwarmWorker } from "../cluster/worker"
import { SwarmLease } from "../cluster/lease"
import { SwarmIdempotency } from "../cluster/idempotency"

export const AgentSpawned = Event.define({
  type: "swarm.agent.spawned",
  durable: { version: 1, aggregate: "agentID" },
  schema: {
    agentID: SwarmAgent.ID,
    parentID: optional(SwarmAgent.ID),
    mission: Schema.String,
  },
})

export const AgentStarted = Event.define({
  type: "swarm.agent.started",
  durable: { version: 1, aggregate: "agentID" },
  schema: { agentID: SwarmAgent.ID },
})

export const AgentWaiting = Event.define({
  type: "swarm.agent.waiting",
  durable: { version: 1, aggregate: "agentID" },
  schema: { agentID: SwarmAgent.ID, reason: optional(Schema.String) },
})

export const AgentCompleted = Event.define({
  type: "swarm.agent.completed",
  durable: { version: 1, aggregate: "agentID" },
  schema: { agentID: SwarmAgent.ID, summary: optional(Schema.String) },
})

export const AgentFailed = Event.define({
  type: "swarm.agent.failed",
  durable: { version: 1, aggregate: "agentID" },
  schema: { agentID: SwarmAgent.ID, error: Schema.String, attempts: Schema.Int },
})

export const AgentStateChanged = Event.define({
  type: "swarm.agent.state_changed",
  durable: { version: 1, aggregate: "agentID" },
  schema: {
    agentID: SwarmAgent.ID,
    from: SwarmAgent.State,
    to: SwarmAgent.State,
  },
})

export const TaskCreated = Event.define({
  type: "swarm.task.created",
  durable: { version: 1, aggregate: "taskID" },
  schema: { taskID: SwarmTask.ID, parentID: optional(SwarmTask.ID), title: Schema.String },
})

export const TaskAssigned = Event.define({
  type: "swarm.task.assigned",
  durable: { version: 1, aggregate: "taskID" },
  schema: { taskID: SwarmTask.ID, agentID: SwarmAgent.ID },
})

export const TaskCompleted = Event.define({
  type: "swarm.task.completed",
  durable: { version: 1, aggregate: "taskID" },
  schema: { taskID: SwarmTask.ID, agentID: optional(SwarmAgent.ID) },
})

export const ToolRequested = Event.define({
  type: "swarm.tool.requested",
  durable: { version: 1, aggregate: "agentID" },
  schema: { agentID: SwarmAgent.ID, tool: Schema.String, args: Schema.Record(Schema.String, Schema.Unknown) },
})

export const ToolApproved = Event.define({
  type: "swarm.tool.approved",
  durable: { version: 1, aggregate: "agentID" },
  schema: { agentID: SwarmAgent.ID, tool: Schema.String, scope: Schema.String },
})

export const ToolDenied = Event.define({
  type: "swarm.tool.denied",
  durable: { version: 1, aggregate: "agentID" },
  schema: { agentID: SwarmAgent.ID, tool: Schema.String, reason: Schema.String },
})

export const ArtifactCreated = Event.define({
  type: "swarm.artifact.created",
  durable: { version: 1, aggregate: "artifactID" },
  schema: {
    artifactID: SwarmArtifact.ID,
    agentID: SwarmAgent.ID,
    taskID: optional(SwarmTask.ID),
    kind: SwarmArtifact.Kind,
    ref: Schema.String,
  },
})

export const ReviewCreated = Event.define({
  type: "swarm.review.created",
  durable: { version: 1, aggregate: "reviewID" },
  schema: {
    reviewID: SwarmReview.ID,
    reviewerAgentID: SwarmAgent.ID,
    artifactID: SwarmArtifact.ID,
    verdict: SwarmReview.Verdict,
  },
})

export const ApprovalRequested = Event.define({
  type: "swarm.approval.requested",
  durable: { version: 1, aggregate: "agentID" },
  schema: { request: SwarmApproval.Request },
})

export const ApprovalGranted = Event.define({
  type: "swarm.approval.granted",
  durable: { version: 1, aggregate: "agentID" },
  schema: { requestID: SwarmApproval.ID, agentID: SwarmAgent.ID, reply: SwarmApproval.Reply },
})

export const ApprovalDenied = Event.define({
  type: "swarm.approval.denied",
  durable: { version: 1, aggregate: "agentID" },
  schema: { requestID: SwarmApproval.ID, agentID: SwarmAgent.ID },
})

export const WorkspaceCreated = Event.define({
  type: "swarm.workspace.created",
  durable: { version: 1, aggregate: "agentID" },
  schema: { agentID: SwarmAgent.ID, path: Schema.String, branch: optional(Schema.String) },
})

export const WorkspaceReleased = Event.define({
  type: "swarm.workspace.released",
  durable: { version: 1, aggregate: "agentID" },
  schema: { agentID: SwarmAgent.ID, path: Schema.String },
})

export const FindingClustered = Event.define({
  type: "swarm.finding.clustered",
  durable: { version: 1, aggregate: "findingID" },
  schema: {
    findingID: SwarmDedup.FindingID,
    reporters: Schema.Array(SwarmAgent.ID),
    canonicalTitle: Schema.String,
  },
})

export const IntegrationProposed = Event.define({
  type: "swarm.integration.proposed",
  durable: { version: 1, aggregate: "missionID" },
  schema: {
    missionID: Schema.String,
    artifactIDs: Schema.Array(SwarmArtifact.ID),
    changedFiles: Schema.Int,
    testsAdded: Schema.Int,
  },
})

export const IntegrationApproved = Event.define({
  type: "swarm.integration.approved",
  durable: { version: 1, aggregate: "missionID" },
  schema: { missionID: Schema.String, approver: Schema.String },
})

export const IntegrationRejected = Event.define({
  type: "swarm.integration.rejected",
  durable: { version: 1, aggregate: "missionID" },
  schema: { missionID: Schema.String, reason: optional(Schema.String) },
})

export const WorkerRegistered = Event.define({
  type: "swarm.worker.registered",
  durable: { version: 1, aggregate: "workerID" },
  schema: { workerID: SwarmWorker.ID, name: Schema.String },
})

export const WorkerOffline = Event.define({
  type: "swarm.worker.offline",
  durable: { version: 1, aggregate: "workerID" },
  schema: { workerID: SwarmWorker.ID, reason: Schema.String },
})

export const WorkerDraining = Event.define({
  type: "swarm.worker.draining",
  durable: { version: 1, aggregate: "workerID" },
  schema: { workerID: SwarmWorker.ID },
})

export const LeaseIssued = Event.define({
  type: "swarm.lease.issued",
  durable: { version: 1, aggregate: "leaseID" },
  schema: { leaseID: SwarmLease.ID, agentID: SwarmAgent.ID, workerID: SwarmWorker.ID },
})

export const LeaseClaimed = Event.define({
  type: "swarm.lease.claimed",
  durable: { version: 1, aggregate: "leaseID" },
  schema: { leaseID: SwarmLease.ID, workerID: SwarmWorker.ID, agentID: SwarmAgent.ID },
})

export const LeaseCompleted = Event.define({
  type: "swarm.lease.completed",
  durable: { version: 1, aggregate: "leaseID" },
  schema: { leaseID: SwarmLease.ID, workerID: SwarmWorker.ID, agentID: SwarmAgent.ID },
})

export const LeaseFailed = Event.define({
  type: "swarm.lease.failed",
  durable: { version: 1, aggregate: "leaseID" },
  schema: { leaseID: SwarmLease.ID, workerID: SwarmWorker.ID, agentID: SwarmAgent.ID, reason: Schema.String, retryable: Schema.Boolean },
})

export const LeaseExpired = Event.define({
  type: "swarm.lease.expired",
  durable: { version: 1, aggregate: "leaseID" },
  schema: { leaseID: SwarmLease.ID, workerID: optional(SwarmWorker.ID), agentID: SwarmAgent.ID },
})

export const OperationCompleted = Event.define({
  type: "swarm.operation.completed",
  durable: { version: 1, aggregate: "opID" },
  schema: { opID: SwarmIdempotency.ID, kind: Schema.String },
})

export const ModelSelected = Event.define({
  type: "swarm.model.selected",
  durable: { version: 1, aggregate: "agentID" },
  schema: {
    agentID: SwarmAgent.ID,
    mission: Schema.String,
    requestedModel: optional(Schema.String),
    requestedCapability: optional(Schema.String),
    requestedPool: optional(Schema.String),
    model: Schema.String,
    // Operational routing reason only — never pricing or credentials.
    reason: Schema.String,
    fallbackOrder: Schema.Array(Schema.String),
  },
})

export const ModelHealthChanged = Event.define({
  type: "swarm.model.health_changed",
  durable: { version: 1, aggregate: "modelID" },
  schema: { model: Schema.String, health: Schema.String },
})

export const BudgetWarned = Event.define({
  type: "swarm.budget.warned",
  durable: { version: 1, aggregate: "missionID" },
  schema: { missionID: Schema.String, used_calls: Schema.Int, used_tokens: Schema.Int },
})

export const BudgetHardReached = Event.define({
  type: "swarm.budget.hard_reached",
  durable: { version: 1, aggregate: "missionID" },
  schema: { missionID: Schema.String, used_calls: Schema.Int, used_tokens: Schema.Int },
})

export const BudgetIncreaseRequested = Event.define({
  type: "swarm.budget.increase_requested",
  durable: { version: 1, aggregate: "missionID" },
  schema: { requestID: SwarmApproval.ID, agentID: SwarmAgent.ID, missionID: Schema.String, reason: Schema.String },
})

export const BudgetIncreaseResolved = Event.define({
  type: "swarm.budget.increase_resolved",
  durable: { version: 1, aggregate: "missionID" },
  schema: { requestID: SwarmApproval.ID, missionID: Schema.String, decision: Schema.String },
})

export const ChildBudgetDelegated = Event.define({
  type: "swarm.budget.child_delegated",
  durable: { version: 1, aggregate: "agentID" },
  schema: { parentID: SwarmAgent.ID, childID: SwarmAgent.ID, missionID: Schema.String, model_calls: Schema.Int },
})

export const Definitions = Event.inventory(
  AgentSpawned,
  AgentStarted,
  AgentWaiting,
  AgentCompleted,
  AgentFailed,
  AgentStateChanged,
  TaskCreated,
  TaskAssigned,
  TaskCompleted,
  ToolRequested,
  ToolApproved,
  ToolDenied,
  ArtifactCreated,
  ReviewCreated,
  ApprovalRequested,
  ApprovalGranted,
  ApprovalDenied,
  WorkspaceCreated,
  WorkspaceReleased,
  FindingClustered,
  IntegrationProposed,
  IntegrationApproved,
  IntegrationRejected,
  WorkerRegistered,
  WorkerOffline,
  WorkerDraining,
  LeaseIssued,
  LeaseClaimed,
  LeaseCompleted,
  LeaseFailed,
  LeaseExpired,
  OperationCompleted,
  ModelSelected,
  ModelHealthChanged,
  BudgetWarned,
  BudgetHardReached,
  BudgetIncreaseRequested,
  BudgetIncreaseResolved,
  ChildBudgetDelegated,
)