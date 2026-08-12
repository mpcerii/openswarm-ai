export * as SwarmClusterSim from "./cluster-simulation"

import { SwarmAgent } from "../agent/agent"
import { SwarmConfig } from "../config/config"
import { SwarmProvider } from "../provider/provider"
import { SwarmWorker } from "../cluster/worker"
import { SwarmCredentials } from "../cluster/credentials"
import { SwarmStore } from "../storage/store"
import { MemoryStore } from "../storage/memory"
import { ControlPlane } from "../control/control"
import { WorkerNode } from "../worker/node"

// ---------------------------------------------------------------------------
// Distributed-mode simulation harness: one control plane, N worker nodes,
// thousands of logical agents, all over the in-memory store (no external
// infra). Worker nodes are independent execution engines with their own
// providers; only the store and the control plane are shared, exactly like a
// real cluster shares its durable state. Used by the cluster + chaos tests.
// ---------------------------------------------------------------------------

export interface ClusterSimOptions {
  readonly population: number
  readonly activeBound: number
  readonly workspaceBound: number
  readonly childrenPerAgent: number
  readonly maxDepth: number
  readonly workerCount: number
  readonly maxConcurrentPerWorker: number
  readonly llmCap: number
  readonly heartbeatTimeoutMs?: number
  readonly leaseTimeoutMs?: number
  readonly clockStepMs?: number
  readonly provider?: () => SwarmProvider.Provider
  readonly seed?: number
  // Model routing / governance options (Phase 2).
  readonly allowedModels?: string[]
  readonly pools?: Record<string, string[]>
  readonly routingPolicy?: SwarmConfig.RoutingPolicy
  readonly catalog?: Record<string, SwarmConfig.ModelCatalogEntry>
  readonly modelLimits?: Record<string, SwarmConfig.ModelLimits>
  readonly providerLimits?: Record<string, SwarmConfig.ProviderLimits>
  readonly missionBudget?: SwarmConfig.MissionBudget
}

export interface ClusterSimResult {
  readonly control: ControlPlane
  readonly store: SwarmStore.DurableStore
  readonly workers: WorkerNode[]
  readonly primaryID: SwarmAgent.ID
  rounds: number
  readonly accounting: SwarmStore.ConcurrencySnapshot
  readonly clock: SimClock
}

export function defaultClusterConfig(opts: ClusterSimOptions): SwarmConfig.Info {
  const maxAgents = Math.max(opts.population, 10000)
  const allowed = opts.allowedModels ?? ["fake/echo"]
  return {
    enabled: true,
    max_agents: maxAgents,
    max_active_agents: opts.activeBound,
    max_active_coding_workspaces: opts.workspaceBound,
    max_depth: opts.maxDepth,
    max_children_per_agent: opts.childrenPerAgent,
    models: {
      allowed,
      pools: opts.pools,
      catalog: opts.catalog,
      routing: { policy: opts.routingPolicy ?? "balanced" },
      limits: opts.modelLimits,
      providers: opts.providerLimits,
      global_concurrency: undefined,
      mission_token_budget: undefined,
    },
    approval: {
      spawn: "allow",
      workspace_write: "allow",
      dependency_change: "deny",
      git_commit: "deny",
      git_push: "deny",
      merge: "deny",
      external_side_effect: "deny",
      mission_plan: "allow",
      integration: "allow",
      budget_increase: "ask",
    },
    budget: opts.missionBudget === undefined ? undefined : { default: opts.missionBudget, soft_ratio: 0.8 },
  }
}

export async function makeCluster(opts: ClusterSimOptions): Promise<ClusterSimResult> {
  const clock = new SimClock(opts.clockStepMs ?? 5)
  const limits = {
    max_agents: Math.max(opts.population, 10000),
    max_active_agents: opts.activeBound,
    max_depth: opts.maxDepth,
    max_children_per_agent: opts.childrenPerAgent,
  }
  const store = new MemoryStore(limits, opts.llmCap, opts.workspaceBound)
  const config = defaultClusterConfig(opts)
  const control = new ControlPlane({
    store,
    config,
    llmCap: opts.llmCap,
    heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? 5_000,
    leaseTimeoutMs: opts.leaseTimeoutMs ?? 30_000,
    now: () => clock.now(),
  })

  const primaryID = SwarmAgent.ID.create()
  const mission = await control.createMission({ title: "cluster simulation", brief: "distributed stress", primaryAgentID: primaryID })
  await control.registerPrimary({ missionID: mission.id, agentID: primaryID })

  const workers: WorkerNode[] = []
  for (let i = 0; i < opts.workerCount; i++) {
    const workerID = SwarmWorker.ID.create()
    const { credential, secret } = await control.issueCredential({
      workerID,
      name: `worker-${i + 1}`,
      scopes: {
        capabilities: [],
        providers: ["fake"],
        models: [],
        platforms: [],
      },
    })
    const worker = new WorkerNode({
      id: workerID,
      name: `worker-${i + 1}`,
      capabilities: {
        workerID,
        maxConcurrentAgents: opts.maxConcurrentPerWorker,
        maxConcurrentTools: opts.maxConcurrentPerWorker * 2,
        supportedPlatforms: ["linux", "win32"],
        capabilities: ["coding-workspace", "review"],
        availableModels: ["fake/echo"],
        git: true,
        shell: false,
        sandbox: true,
      },
      credentialID: credential.id,
      secret,
      provider: opts.provider ? opts.provider() : SwarmProvider.echoProvider(),
      api: control,
      now: () => clock.now(),
      maxClaimsPerPump: opts.maxConcurrentPerWorker,
    })
    const registered = await worker.register(clock.now())
    if (!registered) throw new Error(`worker ${workerID} failed to register`)
    workers.push(worker)
  }

  await spawnPopulation(control, mission.id, primaryID, opts)
  return { control, store, workers, primaryID, rounds: 0, accounting: await store.accounting(), clock }
}

// Fan-out spawn: the primary spawns children, bounded by depth/population,
// like the local 10k harness. Each spawn is durably budgeted.
async function spawnPopulation(control: ControlPlane, missionID: string, primaryID: SwarmAgent.ID, opts: ClusterSimOptions): Promise<void> {
  const remaining = opts.population - 1
  const queue: Array<{ parent: SwarmAgent.ID; depth: number }> = [{ parent: primaryID, depth: 0 }]
  let spawned = 0
  while (queue.length > 0 && spawned < remaining) {
    const node = queue.shift()!
    const childDepth = node.depth + 1
    const childrenToSpawn = Math.min(opts.childrenPerAgent, remaining - spawned)
    for (let i = 0; i < childrenToSpawn; i++) {
      const role = childDepth <= 1 ? "investigator" : childDepth === 2 ? "implementer" : "reviewer"
      const result = await control.spawn(node.parent, { missionID, role })
      if (result.type !== "spawned") break
      const childID = result.agents[0]!
      spawned++
      if (childDepth < opts.maxDepth) queue.push({ parent: childID, depth: childDepth })
    }
  }
}

// Drive the cluster to a fixed point: agents completed, queue drained, no
// active leases. The virtual clock advances once per round so heartbeat and
// lease timeouts behave like wall-clock time across worker processes.
export async function driveToFixedPoint(sim: ClusterSimResult, maxRounds = 2000): Promise<number> {
  let rounds = 0
  while (rounds < maxRounds) {
    rounds++
    sim.clock.step()
    await sim.control.tick()
    for (const worker of sim.workers) {
      if (!worker.terminated) await worker.pump()
    }
    const allDone = await isMissionDone(sim)
    if (allDone) break
  }
  sim.rounds = rounds
  return rounds
}

export async function isMissionDone(sim: ClusterSimResult): Promise<boolean> {
  const agents = await sim.store.listAgents()
  for (const agent of agents) {
    if (agent.id === sim.primaryID) continue
    if (!SwarmAgent.isDone(agent.state)) return false
  }
  const accounting = await sim.store.accounting()
  return accounting.activeAgents === 0
}

export async function runClusterSim(opts: ClusterSimOptions): Promise<ClusterSimResult> {
  const sim = await makeCluster(opts)
  await driveToFixedPoint(sim)
  return sim
}

// Deterministic PRNG (mulberry32) so chaos scenarios are reproducible.
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class SimClock {
  private t: number
  constructor(private readonly stepMs: number) {
    this.t = 1_700_000_000_000
  }
  now(): number {
    return this.t
  }
  // Advance one drive-round step.
  step(): void {
    this.t += this.stepMs
  }
  jumpTo(t: number): void {
    this.t = t
  }
}
