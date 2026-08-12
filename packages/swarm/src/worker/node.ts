export * as SwarmWorkerNode from "./node"

import { SwarmAgent } from "../agent/agent"
import { SwarmWorker } from "../cluster/worker"
import { SwarmLease } from "../cluster/lease"
import { SwarmIdempotency } from "../cluster/idempotency"
import { SwarmProvider } from "../provider/provider"
import { SwarmRecovery } from "../recovery/recovery"
import type { ControlPlaneApi } from "../cluster/transport"
import { runAgent, type RunResult } from "./runner"

// ---------------------------------------------------------------------------
// A worker node: an independent execution engine. It holds NO durable state —
// agents, missions, census, artifacts, and accounting all live on the control
// plane. A worker registers, heartbeats, claims leases, runs agents, and acks
// or nacks. The same class drives the in-process simulation and a real
// networked deployment (only the ControlPlaneApi implementation differs).
// ---------------------------------------------------------------------------

export interface WorkerParams {
  readonly id: SwarmWorker.ID
  readonly name: string
  readonly capabilities: SwarmWorker.Capabilities
  readonly credentialID: string
  readonly secret: string
  readonly provider: SwarmProvider.Provider
  readonly api: ControlPlaneApi
  readonly now?: () => number
  // Max leases claimed per pump; bounded by maxConcurrentAgents regardless.
  readonly maxClaimsPerPump?: number
  readonly leaseHeartbeatMs?: number
  readonly version?: string
}

export class WorkerNode {
  readonly id: SwarmWorker.ID
  health: SwarmWorker.Health = "healthy"
  registered = false
  draining = false
  terminated = false
  readonly leasesTotal: number = 0
  readonly leasesFailed: number = 0

  private readonly name: string
  private readonly capabilities: SwarmWorker.Capabilities
  private readonly credentialID: string
  private readonly secret: string
  private readonly version: string | undefined
  private readonly api: ControlPlaneApi
  private readonly provider: SwarmProvider.Provider
  private readonly now: () => number
  private readonly maxClaimsPerPump: number
  private readonly leaseHeartbeatMs: number
  private readonly active = new Map<string, SwarmLease.Record>()

  constructor(params: WorkerParams) {
    this.id = params.id
    this.name = params.name
    this.capabilities = params.capabilities
    this.credentialID = params.credentialID
    this.secret = params.secret
    this.provider = params.provider
    this.api = params.api
    this.now = params.now ?? Date.now
    this.maxClaimsPerPump = params.maxClaimsPerPump ?? Math.max(1, this.capabilities.maxConcurrentAgents)
    this.leaseHeartbeatMs = params.leaseHeartbeatMs ?? 10_000
    this.version = params.version
  }

  async register(now = this.now()): Promise<boolean> {
    const res = await this.api.register(
      {
        workerID: this.id,
        name: this.name,
        capabilities: this.capabilities,
        credentialID: this.credentialID,
        version: this.version,
      },
      this.secret,
      now,
    )
    if (!res.accepted) return false
    this.registered = true
    this.health = "healthy"
    return true
  }

  // One iteration of the worker loop: heartbeat, then claim + execute up to
  // the worker's concurrency ceiling.
  async pump(now = this.now()): Promise<void> {
    if (this.terminated) return
    const health: SwarmWorker.Health = this.draining ? "draining" : this.active.size > 0 ? "busy" : "healthy"
    await this.api.heartbeat(this.id, health, this.active.size, now)
    if (this.draining) {
      if (this.active.size === 0) {
        await this.api.heartbeat(this.id, "offline", 0, now)
        this.terminated = true
      }
      return
    }
    let claimed = 0
    while (claimed < this.maxClaimsPerPump && this.active.size < this.capabilities.maxConcurrentAgents) {
      const lease = await this.api.claimLease(this.id, now)
      if (lease === undefined) break
      this.active.set(lease.id, lease)
      claimed++
    }
    for (const lease of [...this.active.values()]) {
      await this.execute(lease, now)
    }
  }

  async drain(now = this.now()): Promise<void> {
    if (this.terminated) return
    this.draining = true
    await this.api.drain(this.id, now)
  }

  // Chaos harness: the worker vanishes without draining. Heartbeats stop and
  // its leases expire on the control plane; the agents are requeued.
  async terminate(now = this.now()): Promise<void> {
    this.terminated = true
    void now
  }

  private async execute(lease: SwarmLease.Record, now: number): Promise<void> {
    const agent = await this.api.getAgent(lease.agent_id)
    if (agent === undefined) {
      await this.api.ackLease(this.id, lease.id, { state: "completed", reason: "agent missing" }, now)
      this.active.delete(lease.id)
      return
    }
    const [mission, census, inbox] = await Promise.all([
      this.api.getMission(agent.mission),
      this.api.getCensus(agent.mission),
      this.api.messagesForAgent(agent.id),
    ])
    const opID = SwarmIdempotency.ID.create()
    const began = await this.api.beginAgentRun(agent.id, lease.run_number, opID, this.id, now)
    if (began.duplicate) {
      // A previous attempt already completed this run; replay its result
      // instead of re-executing (no duplicate PRs, patches, or spawns).
      await this.api.ackLease(this.id, lease.id, began.result, now)
      this.active.delete(lease.id)
      return
    }
    const llmReserved = await this.tryReserveLLM(lease, now)
    if (!llmReserved) {
      await this.api.nackLease(this.id, lease.id, "llm_capacity", true, now)
      this.active.delete(lease.id)
      return
    }
    await this.api.markLeaseLLM(this.id, lease.id, true)
    // Per-model/provider rate-limit governor. Denial requeues the agent (the
    // control plane honors the backoff before re-issuing a lease); the LLM
    // slot is released by the control plane on nack. Never hard-fails.
    if (agent.resolvedModel !== undefined) {
      const capacity = await this.api.reserveModelCapacity(this.id, lease.id, agent.resolvedModel, this.now())
      if (!capacity.ok) {
        await this.api.nackLease(this.id, lease.id, `model_capacity:${capacity.code}`, true, this.now())
        this.active.delete(lease.id)
        return
      }
    }
    try {
      const result = await runAgent({ agent, mission, census, inbox, provider: this.provider, api: this.api, now: this.now })
      await this.api.completeAgentRun(agent.id, lease.run_number, opID, result, this.now())
      await this.api.ackLease(this.id, lease.id, result, this.now())
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      const failure = SwarmRecovery.classify(error)
      // Agent-model / tool / task failures retry; a cancelled agent is terminal.
      const retryable = failure !== "agent_cancelled" && failure !== "malformed_tool_output"
      await this.api.nackLease(this.id, lease.id, error.message, retryable, this.now())
    } finally {
      // The control plane releases the LLM slot via the lease's llm_reserved
      // flag on ack/nack/expiry; the worker never double-releases.
      await this.api.markLeaseLLM(this.id, lease.id, false)
      this.active.delete(lease.id)
    }
  }

  // Wait for a global LLM slot, extending the lease so it does not expire
  // while we hold it. Bounded: a full cluster LLM cap nacks and requeues.
  private async tryReserveLLM(lease: SwarmLease.Record, now: number): Promise<boolean> {
    for (let wait = 0; wait < 40; wait++) {
      const reserved = await this.api.reserveLLM(this.id)
      if (reserved) return true
      await this.api.extendLease(this.id, lease.id, this.leaseHeartbeatMs, now)
      now = this.now()
    }
    return false
  }
}
