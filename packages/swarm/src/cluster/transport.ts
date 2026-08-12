export * as SwarmTransport from "./transport"

import type { SwarmAgent } from "../agent/agent"
import type { SwarmTask } from "../task/task"
import type { SwarmMessage } from "../messaging/message"
import type { SwarmArtifact } from "../artifacts/artifact"
import type { SwarmCensus } from "../census/census"
import type { SwarmApproval } from "../approvals/approval"
import type { SwarmDedup } from "../dedup/dedup"
import type { SwarmWorker } from "./worker"
import type { SwarmLease } from "./lease"
import type { SwarmStore } from "../storage/store"
import type { SwarmClusterMetrics } from "./metrics"

// ---------------------------------------------------------------------------
// The worker-facing surface of the control plane. A worker depends ONLY on
// this interface: it has no store, no scheduler, no policy. The control plane
// never calls providers — model execution happens on workers. In-process
// simulation wires the ControlPlane instance directly; a remote deployment
// implements the same interface over an authenticated transport.
// ---------------------------------------------------------------------------

export interface LeaseOutcome {
  readonly ok: true
  readonly lease: SwarmLease.Record
  readonly result: unknown
}

export interface ControlPlaneApi {
  register(registration: SwarmWorker.Registration, secret: string, now: number): Promise<SwarmWorker.RegisterResult>
  heartbeat(workerID: string, status: SwarmWorker.Health, activeLeases: number, now: number): Promise<void>
  drain(workerID: string, now: number): Promise<void>

  // Lease lifecycle. The worker pulls; the scheduler has already matched the
  // agent to this worker and published a lease delivery for it.
  claimLease(workerID: string, now: number): Promise<SwarmLease.Record | undefined>
  extendLease(workerID: string, leaseID: string, ms: number, now: number): Promise<boolean>
  // Record whether the worker reserved a global LLM slot for this lease so the
  // control plane can release leaked slots when the worker dies.
  markLeaseLLM(workerID: string, leaseID: string, reserved: boolean): Promise<boolean>
  ackLease(workerID: string, leaseID: string, result: unknown, now: number): Promise<LeaseOutcome | { ok: false; reason: string }>
  nackLease(workerID: string, leaseID: string, reason: string, retryable: boolean, now: number): Promise<{ ok: true } | { ok: false; reason: string }>

  // Context reads for the executing agent.
  getAgent(agentID: string): Promise<SwarmAgent.AgentRecord | undefined>
  getMission(id: string): Promise<SwarmStore.MissionRecord | undefined>
  getCensus(id: string): Promise<SwarmCensus.Info | undefined>
  messagesForAgent(agentID: string): Promise<SwarmMessage.Info[]>

  // Idempotent agent-run execution. The worker generates the operation id and
  // run number; a duplicate key replays the recorded result instead of
  // re-executing.
  beginAgentRun(agentID: string, runNumber: number, opID: string, workerID: string, now: number): Promise<{ duplicate: false } | { duplicate: true; result: unknown }>
  completeAgentRun(agentID: string, runNumber: number, opID: string, result: unknown, now: number): Promise<void>

  // Side-effectful writes, idempotent where a retry must not duplicate.
  emitAudit(type: string, data: unknown, now: number): Promise<void>
  clusterFinding(agentID: string, report: SwarmDedup.Report): Promise<{ findingID: string }>
  createArtifact(agentID: string, opKey: string, patch: SwarmArtifact.PatchBody, now: number): Promise<SwarmArtifact.PatchRecord>
  createTask(agentID: string, title: string, now: number): Promise<SwarmTask.Info>
  requestApproval(agentID: string, action: SwarmApproval.Action, resource: string, summary: string, now: number): Promise<SwarmApproval.Request | undefined>

  // Global concurrency + scoped secrets.
  reserveLLM(workerID: string): Promise<boolean>
  releaseLLM(workerID: string): Promise<void>
  resolveSecret(workerID: string, agentID: string, ref: string): Promise<{ value: string } | { denied: string }>

  // Per-model/per-provider rate-limit reservation. The worker calls this after
  // reserving the global LLM slot, before running the agent; a denial carries
  // a backoff and the worker requeues the agent (never hard-fails it).
  reserveModelCapacity(workerID: string, leaseID: string, model: string, now: number): Promise<{ ok: true } | { ok: false; code: string; backoffMs: number }>

  metrics(): Promise<SwarmClusterMetrics.ClusterMetrics>
}
