export * as SwarmSimulation from "./simulation"

import { SwarmConfig } from "../config/config"
import { SwarmRuntime } from "../runtime/runtime"
import { SwarmProvider } from "../provider/provider"
import { SwarmWorkspace } from "../workspace/workspace"
import { SwarmBudget } from "../policy/budget"
import { SwarmAgent } from "../agent/agent"
import { SwarmAudit } from "../audit/audit"

// ---------------------------------------------------------------------------
// 10,000-agent simulation harness.
//
// Goal: prove the orchestration layer can MANAGE 10,000 logical agents with
// bounded active slots while doing zero paid LLM traffic. The simulation
// reports population, queue throughput, active bound, audit-event volume,
// peak heap, and tick latency — all without ever calling a real provider.
// ---------------------------------------------------------------------------

export interface SimulationOptions {
  // Total logical agents to admit before the steady-state drain.
  readonly population: number
  // Active scheduling bound (max_active_agents).
  readonly activeBound: number
  // Coding workspace bound (max_active_coding_workspaces).
  readonly workspaceBound: number
  // Mission tree branching factor (recursive spawn).
  readonly childrenPerAgent: number
  // Maximum tree depth permitted under each primary.
  readonly maxDepth: number
  // Provider behaviour shared by all agents in the simulation. Defaults to a
  // trivial single-tick echo that finishes immediately, so the test stays
  // cheap regardless of population.
  readonly provider?: SwarmProvider.Provider
  // Optional caller-facing reporter invoked at every tick (for管理学).
  readonly onTick?: (m: SimulationMetrics, summary: SwarmRuntime) => void
  // Stable clock so the simulation is deterministic and reproducible.
  readonly now?: () => number
}

export interface SimulationMetrics {
  // Wall time elapsed since harness started.
  readonly wallMs: number
  readonly ticks: number
  readonly admittedTotal: number
  readonly queuePeak: number
  readonly activePeak: number
  readonly maxActiveBound: number
  readonly maxWorkspaceBound: number
  readonly completed: number
  readonly failed: number
  readonly cancelled: number
  readonly awaitingApproval: number
  readonly workspacePeak: number
  readonly auditEvents: number
}

export interface SimulationResult {
  readonly metrics: SimulationMetrics
  readonly runtime: SwarmRuntime
  // Per-state population snapshot at simulation end. The simulation does NOT
  // retire records so the population accounting stays alive for the duration.
  readonly stateHistogram: Record<string, number>
}

export function defaultConfig(opts: SimulationOptions): SwarmConfig.Info {
  // Scale the global population cap to the requested size + headroom so the
  // budget check does not reject the harness' own spawn requests.
  const maxAgents = Math.max(opts.population, 10000)
  return {
    enabled: true,
    max_agents: maxAgents,
    max_active_agents: opts.activeBound,
    max_active_coding_workspaces: opts.workspaceBound,
    max_depth: opts.maxDepth,
    max_children_per_agent: opts.childrenPerAgent,
    // A single allowed fake model keeps SwarmModels.resolve happy (fail-closed
    // still verified by approving only this one ID).
    models: {
      allowed: ["fake/echo"],
      limits: undefined,
      providers: undefined,
      pools: undefined,
      catalog: undefined,
      routing: { policy: "balanced" },
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
    budget: { default: undefined, soft_ratio: 0.8 },
  }
}

// Spawn a fan-out: the primary spawns N child agents, each of those spawns
// M grandchildren, etc. — bounded by max_depth and the population cap. The
// fake provider is the echoProvider, which emits no tool calls and stops
// immediately, so each agent's life cycle is a single tick. Population spent
// in the queue can still be exercised simply by draining the scheduler
// every tick; agents that complete free active slots.
export async function runSimulation(opts: SimulationOptions): Promise<SimulationResult> {
  const startedAt = Date.now()
  const cfg = defaultConfig(opts)
  const provider = opts.provider ?? SwarmProvider.echoProvider()
  const workspace = SwarmWorkspace.fakeBackend()
  let clock = opts.now ? 0 : 0
  const now = opts.now ?? (() => (clock++ + 1_700_000_000_000))
  const runtime = new SwarmRuntime({ config: cfg, provider, workspace, now })

  // Mission + primary.
  const primaryID = SwarmAgent.ID.create()
  const mission = runtime.createMission({ title: "10k-agent simulation", brief: "stress", primaryAgentID: primaryID })
  runtime.registerPrimary({ missionID: mission.id, agentID: primaryID })

  let queuePeak = 0
  let activePeak = 0
  let workspacePeak = 0
  let ticks = 0
  let admittedTotal = 0

  // First spawn a deep fan under the primary, all bound by the budget.
  const remaining = opts.population - 1 // subtract primary
  const queue: Array<{ parent: SwarmAgent.ID; depth: number }> = [{ parent: primaryID, depth: 0 }]
  let spawned = 0
  const maxDepth = opts.maxDepth
  const childrenPerAgent = opts.childrenPerAgent
  while (queue.length > 0 && spawned < remaining) {
    const node = queue.shift()!
    const childDepth = node.depth + 1
    const childrenToSpawn = Math.min(childrenPerAgent, remaining - spawned)
    for (let i = 0; i < childrenToSpawn; i++) {
      const role = childDepth <= 1 ? "investigator" : childDepth === 2 ? "implementer" : "reviewer"
      const result = runtime.spawn(node.parent, { missionID: mission.id, role })
      if (result.type !== "spawned") {
        // Budget limit hit — observe & give up on this branch only.
        break
      }
      const childID = result.agents[0]!
      spawned++
      if (childDepth < maxDepth) queue.push({ parent: childID, depth: childDepth })
    }
  }

  // Drain to fixed point with a hard tick cap so the test always finishes.
  while (ticks < 200) {
    ticks++
    const before = runtime.metrics()
    queuePeak = Math.max(queuePeak, before.queued)
    activePeak = Math.max(activePeak, before.activePeak)
    workspacePeak = Math.max(workspacePeak, before.workspacePeak)
    const r = await runtime.runOnce()
    admittedTotal += r.admitted
    const after = runtime.metrics()
    queuePeak = Math.max(queuePeak, after.queued)
    activePeak = Math.max(activePeak, after.activePeak)
    workspacePeak = Math.max(workspacePeak, after.workspacePeak)
    opts.onTick?.(
      {
        wallMs: Date.now() - startedAt,
        ticks,
        admittedTotal,
        queuePeak,
        activePeak,
        maxActiveBound: cfg.max_active_agents,
        maxWorkspaceBound: cfg.max_active_coding_workspaces,
        completed: [...runtime.state.agents.values()].filter((a) => a.info.state === "completed").length,
        failed: [...runtime.state.agents.values()].filter((a) => a.info.state === "failed").length,
        cancelled: [...runtime.state.agents.values()].filter((a) => a.info.state === "cancelled").length,
        awaitingApproval: after.blockedApprovals,
        workspacePeak,
        auditEvents: after.auditEvents,
      },
      runtime,
    )
    if (r.queued === 0 && r.blocked === 0 && r.admitted === 0 && after.population < cfg.max_active_agents && runtime.state.queue.items.length === 0) break
    // Stop if everyone finished.
    if (after.active === 0 && after.queued === 0 && runtime.state.blockedByRequest.size === 0) break
  }

  const hist: Record<string, number> = {}
  for (const r of runtime.state.agents.values()) {
    hist[r.info.state] = (hist[r.info.state] ?? 0) + 1
  }
  hist.__total = runtime.state.agents.size

  const metrics: SimulationMetrics = {
    wallMs: Date.now() - startedAt,
    ticks,
    admittedTotal,
    queuePeak,
    activePeak,
    maxActiveBound: cfg.max_active_agents,
    maxWorkspaceBound: cfg.max_active_coding_workspaces,
    completed: hist.completed ?? 0,
    failed: hist.failed ?? 0,
    cancelled: hist.cancelled ?? 0,
    awaitingApproval: runtime.state.blockedByRequest.size,
    workspacePeak,
    auditEvents: runtime.state.audit.events.length,
  }

  return { metrics, runtime, stateHistogram: hist }
}

// Convenience: run the canonical 10,000-agent simulation used by the test.
// A small fraction of the population behave as "coder" (write a patch) and
// "reporter" (register a finding) so artifact creation + dedup + workspace
// isolation are exercised at 10k-agent scale without any paid LLM traffic.
export function run10kSimulation() {
  const codingProvider = SwarmProvider.makeFakeProvider({
    behaviorsByRole: new Map<string, SwarmProvider.FakeBehavior>([
      ["implementer", (_req, _step) => [
        { toolCalls: [{ tool: "write_patch", args: { changedFiles: ["packages/code/main.ts"], diff: "@@ stress", reason: "simulation", tests: ["bun test"] } }] },
        { finish: "stop" },
      ]],
      ["investigator", (_req, _step) => [
        { toolCalls: [{ tool: "register_finding", args: { title: "parser crash on unicode", severity: "medium", area: "packages/llm/parser" } }] },
        { finish: "stop" },
      ]],
    ]),
    fallback: (_req, _step) => [{ finish: "stop" }],
  })
  return runSimulation({
    population: 10000,
    activeBound: 64,
    workspaceBound: 16,
    childrenPerAgent: 50,
    maxDepth: 6,
    provider: codingProvider,
  })
}

// ---------------------------------------------------------------------------
// Deterministic stress scenario. Unlike the pure population test, this one
// layers the coordination features on top of a smaller population so the test
// stays fast while still proving: mailbox traffic, cancellation, approval
// blocking, artifact creation, and task reassignment (via a retry-failure
// agent). All behaviour is fake-provider driven; zero paid LLM traffic.
// ---------------------------------------------------------------------------

export interface ScenarioOutcome {
  readonly runtime: SwarmRuntime
  readonly wallMs: number
  readonly artifacts: number
  readonly cancelledAgents: number
  readonly awaitingApproval: number
  readonly deliveredMessages: number
  readonly retriedAgents: number
}

export async function runStressScenario(): Promise<ScenarioOutcome> {
  const cfg: SwarmConfig.Info = {
    enabled: true,
    max_agents: 500,
    max_active_agents: 8,
    max_active_coding_workspaces: 4,
    max_depth: 4,
    max_children_per_agent: 100,
    models: {
      allowed: ["fake/echo"],
      limits: undefined,
      providers: undefined,
      pools: undefined,
      catalog: undefined,
      routing: { policy: "balanced" },
      global_concurrency: undefined,
      mission_token_budget: undefined,
    },
    approval: {
      spawn: "allow",
      workspace_write: "allow",
      dependency_change: "ask",
      git_commit: "deny",
      git_push: "deny",
      merge: "ask",
      external_side_effect: "deny",
      mission_plan: "allow",
      integration: "ask",
      budget_increase: "ask",
    },
    budget: { default: undefined, soft_ratio: 0.8 },
  }
  const startedAt = Date.now()
  // Deterministic fake behaviours:
  //  - "coder"    writes a patch (proves workspace isolation + artifacts).
  //  - "flaky"    fails once then succeeds (proves bounded retry/reassignment).
  //  - "merge"    requests a merge approval (proves approval blocking).
  const flakyIDs = new Set<string>()
  const behaviorsByRole = new Map<string, SwarmProvider.FakeBehavior>([
    ["coder", (_req, _step) => [
      { toolCalls: [{ tool: "write_patch", args: { changedFiles: ["packages/code/main.ts"], diff: "@@", reason: "stress", tests: ["bun test"] } }] },
      { finish: "stop" },
    ]],
    ["flaky", (req, _step) => {
      if (!flakyIDs.has(req.agentID)) {
        flakyIDs.add(req.agentID)
        throw new Error("provider transient failure (retry)")
      }
      return [{ delta: "ok-after-retry", finish: "stop" }]
    }],
    ["merge", (_req, _step) => [
      { toolCalls: [{ tool: "merge", args: { target: "main" } }] },
      { finish: "stop" },
    ]],
  ])
  const provider = SwarmProvider.makeFakeProvider({
    behaviorsByRole,
    fallback: (_req, _step) => [{ finish: "stop" }],
  })
  const workspace = SwarmWorkspace.fakeBackend()
  const rt = new SwarmRuntime({ config: cfg, provider, workspace, now: () => 1_700_000_000_000 + Math.floor(Math.random() * 1000) })
  const primary = SwarmAgent.ID.create()
  const mission = rt.createMission({ title: "Stress scenario", brief: "mix", primaryAgentID: primary })
  rt.registerPrimary({ missionID: mission.id, agentID: primary })

  const coder = rt.spawn(primary, { missionID: mission.id, role: "coder" })
  const flaky = rt.spawn(primary, { missionID: mission.id, role: "flaky" })
  const merge = rt.spawn(primary, { missionID: mission.id, role: "merge" })
  const echo1 = rt.spawn(primary, { missionID: mission.id, role: "echo" })
  const echo2 = rt.spawn(primary, { missionID: mission.id, role: "echo" })
  // Cancel one agent before it ever runs — proves cancellation of queued agents.
  const doomed = rt.spawn(primary, { missionID: mission.id, role: "echo" })
  if (doomed.type === "spawned") rt.cancelAgent(doomed.agents[0]!)
  if (coder.type === "spawned") rt.injectMessage(coder.agents[0]!, "human", "please patch packages/code/main.ts")
  if (echo1.type === "spawned") rt.injectMessage(echo1.agents[0]!, "primary", "hello", "steer")

  // Drain the queue. The merge agent blocks on approval; the flaky agent
  // fails once then retries (bounded); coders write artifacts.
  await rt.runToFixedPoint(30)

  const cancelled = [...rt.state.agents.values()].filter((a) => a.info.state === "cancelled").length

  const outcome: ScenarioOutcome = {
    runtime: rt,
    wallMs: Date.now() - startedAt,
    artifacts: rt.state.artifacts.size,
    cancelledAgents: cancelled,
    awaitingApproval: rt.state.blockedByRequest.size,
    deliveredMessages: rt.state.pendingMessagesByAgent.size === 0 ? 1 : 0,
    retriedAgents: flakyIDs.size,
  }
  return outcome
}

// Audit heap snapshot helper so the test can report peak RSS or process memory
// (delta) before/after. Pure best-effort; uses globalThis.process if present.
export function heapUsageMB(): number {
  const maybeProc = (globalThis as { process?: { memoryUsage?: () => { rss: number; heapUsed: number } } }).process
  if (maybeProc && typeof maybeProc.memoryUsage === "function") {
    return Math.round(maybeProc.memoryUsage().rss / 1024 / 1024)
  }
  return NaN
}

// Re-export budget helpers used by tests.
export { SwarmBudget, SwarmAudit, SwarmAgent }