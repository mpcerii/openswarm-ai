export * as SwarmClusterMetrics from "./metrics"

import type { SwarmWorker } from "./worker"
import type { SwarmLease } from "./lease"
import type { SwarmStore } from "../storage/store"

// Cluster observability surface. Computed from the durable store + worker
// registry so it stays correct across worker processes, and exposed through
// the control plane. Integrates with the event/audit architecture: every
// worker/lease transition is a durable event on top of these counters.

export interface WorkerUtilization {
  workerID: string
  health: SwarmWorker.Health
  active: number
  max: number
  // Fraction of the worker's declared concurrency currently leased.
  ratio: number
}

export interface ClusterMetrics {
  // Workers registered and not offline (healthy + busy + draining).
  connectedWorkers: number
  // Workers currently holding at least one lease.
  activeWorkers: number
  utilization: WorkerUtilization[]
  // Total queued messages (lease deliveries + pending agent runs).
  queueDepth: number
  // Leases in flight (pending/claimed/executing/completing).
  leasedTasks: number
  failedLeases: number
  // Total lease expiry/requeue events (delivery retries).
  retries: number
  agentsByWorker: Record<string, number>
  llmConcurrencyByWorker: Record<string, number>
  globalActiveAgents: number
  globalActiveLLM: number
}

export function compute(
  workers: SwarmWorker.Record[],
  leases: SwarmLease.Record[],
  accounting: SwarmStore.ConcurrencySnapshot,
  queueDepth: number,
): ClusterMetrics {
  const agentsByWorker: Record<string, number> = {}
  const llmByWorker: Record<string, number> = {}
  let failedLeases = 0
  let retries = 0
  let leasedTasks = 0
  for (const lease of leases) {
    if (lease.status === "failed") failedLeases += 1
    if (lease.attempts > 1) retries += 1
    if (lease.status === "pending" || lease.status === "claimed" || lease.status === "executing" || lease.status === "completing") leasedTasks += 1
    if (lease.worker_id !== null && lease.status !== "completed" && lease.status !== "expired") {
      agentsByWorker[lease.worker_id] = (agentsByWorker[lease.worker_id] ?? 0) + 1
    }
  }
  const utilization = workers.map((w) => {
    const active = agentsByWorker[w.id] ?? 0
    const max = w.capabilities.maxConcurrentAgents
    return {
      workerID: w.id,
      health: w.health,
      active,
      max,
      ratio: max === 0 ? 0 : active / max,
    }
  })
  const connected = workers.filter((w) => w.health !== "offline" && w.health !== "unhealthy").length
  const activeWorkers = new Set(
    leases.filter((l) => l.worker_id !== null && (l.status === "claimed" || l.status === "executing" || l.status === "completing")).map((l) => l.worker_id),
  ).size
  return {
    connectedWorkers: connected,
    activeWorkers,
    utilization,
    queueDepth,
    leasedTasks,
    failedLeases,
    retries,
    agentsByWorker,
    llmConcurrencyByWorker: llmByWorker,
    globalActiveAgents: accounting.activeAgents,
    globalActiveLLM: accounting.activeLLM,
  }
}
