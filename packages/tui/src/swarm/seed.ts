import { SwarmRuntime } from "@opencode-ai/swarm/runtime/runtime"
import { SwarmProvider } from "@opencode-ai/swarm/provider/provider"
import { SwarmWorkspace } from "@opencode-ai/swarm/workspace/workspace"
import { SwarmAgent } from "@opencode-ai/swarm/agent/agent"
import { SwarmConfig } from "@opencode-ai/swarm/config/config"
import { SwarmBridge } from "./bridge"

// ---------------------------------------------------------------------------
// Deterministic demo seed. Builds a live, richly-populated swarm kernel that
// the TUI overlay renders: a hierarchy with investigators/implementers/
// reviewers, artifacts + reviews, a blocked-on-approval merge, an integration
// proposal, a budget-increase request, a couple of failures, and a large
// remaining queue so the operator sees the full operational picture. Zero paid
// LLM traffic — everything is fake-provider driven.
// ---------------------------------------------------------------------------

export interface DemoOptions {
  // Total agents to spawn beneath the primary (default 300).
  population?: number
  // Active scheduling bound.
  activeBound?: number
  // Fixed-point ticks to run before presenting (default 3).
  ticks?: number
  now?: () => number
}

export function demoConfig(opts: { activeBound: number; maxTokens: number; maxCalls: number }): SwarmConfig.Info {
  return {
    enabled: true,
    max_agents: 10000,
    max_active_agents: opts.activeBound,
    max_active_coding_workspaces: Math.max(4, Math.floor(opts.activeBound / 3)),
    max_depth: 8,
    max_children_per_agent: 500,
    models: {
      allowed: ["fake/echo", "fake/coder"],
      limits: {
        "fake/echo": { concurrency: opts.activeBound },
        "fake/coder": { concurrency: opts.activeBound },
      },
      providers: undefined,
      pools: { coding: ["fake/coder"], analysis: ["fake/echo"] },
      catalog: {
        "fake/echo": { context_window: 128000, capabilities: { reasoning: true } },
        "fake/coder": { context_window: 128000, capabilities: { tools: true } },
      },
      routing: { policy: "balanced" },
      global_concurrency: opts.activeBound * 2,
      mission_token_budget: opts.maxTokens,
    },
    approval: {
      spawn: "allow",
      workspace_write: "allow",
      dependency_change: "ask",
      git_commit: "ask",
      git_push: "ask",
      merge: "ask",
      external_side_effect: "ask",
      mission_plan: "allow",
      integration: "ask",
      budget_increase: "ask",
    },
    budget: { default: { max_model_calls: opts.maxCalls, max_tokens: opts.maxTokens }, soft_ratio: 0.8 },
  }
}

export async function createDemoRuntime(opts: DemoOptions = {}): Promise<SwarmRuntime> {
  const population = opts.population ?? 300
  const activeBound = opts.activeBound ?? 32
  const config = demoConfig({ activeBound, maxTokens: 2_000_000, maxCalls: 5000 })
  const mergeRequests = new Set<string>()
  const flaky = new Set<string>()
  const behaviorsByRole = new Map<string, SwarmProvider.FakeBehavior>([
    ["investigator", (_req, _step) => [
      { toolCalls: [{ tool: "register_finding", args: { title: "parser crash on unicode input", severity: "medium", area: "packages/llm/parser" } }] },
      { finish: "stop" },
    ]],
    ["implementer", (req, step) => {
      if (step === 0) {
        return [{ toolCalls: [{ tool: "write_patch", args: { changedFiles: ["packages/code/main.ts"], diff: "@@ implementer patch", reason: "implement", tests: ["bun test"], testResults: ["pass"] } }] }]
      }
      return [{ toolCalls: [{ tool: "request_review", args: { objective: "correctness", reviewerCount: 2 } }] }, { finish: "stop" }]
    }],
    ["reviewer", (_req, _step) => [
      { toolCalls: [{ tool: "register_review_finding", args: { severity: "low", message: "looks reasonable" } }] },
      { finish: "stop" },
    ]],
    ["merge", (req, _step) => {
      if (!mergeRequests.has(req.agentID)) {
        mergeRequests.add(req.agentID)
        return [{ toolCalls: [{ tool: "merge", args: { target: "main" } }] }, { finish: "stop" }]
      }
      return [{ finish: "stop" }]
    }],
    ["flaky", (req, _step) => {
      if (!flaky.has(req.agentID)) {
        flaky.add(req.agentID)
        throw new Error("provider transient failure (retry)")
      }
      return [{ delta: "ok-after-retry", finish: "stop" }]
    }],
  ])
  const provider = SwarmProvider.makeFakeProvider({
    behaviorsByRole,
    fallback: (_req, _step) => [{ finish: "stop" }],
  })
  const workspace = SwarmWorkspace.fakeBackend()
  let clock = 0
  const now = opts.now ?? (() => 1_700_000_000_000 + clock++)
  const runtime = new SwarmRuntime({ config, provider, workspace, now })

  const primaryID = SwarmAgent.ID.create()
  const mission = runtime.createMission({
    title: "Runtime investigation",
    brief: "Investigate the crash, implement the fix, review and integrate.",
    primaryAgentID: primaryID,
  })
  runtime.registerPrimary({ missionID: mission.id, agentID: primaryID })

  // Blocking agents first so they reach the approval gate early in the queue.
  const spawned: SwarmAgent.ID[] = []
  for (let i = 0; i < 2; i++) {
    const result = runtime.spawn(primaryID, { missionID: mission.id, role: "merge" })
    if (result.type === "spawned") spawned.push(result.agents[0]!)
  }

  // Fan-out: primary -> investigators, investigators -> implementers + a
  // reviewer per implementer, plus merge/flaky special cases.
  const investigatorIDs: SwarmAgent.ID[] = []
  for (let i = 0; i < Math.min(12, population); i++) {
    const result = runtime.spawn(primaryID, { missionID: mission.id, role: "investigator" })
    if (result.type === "spawned") {
      spawned.push(result.agents[0]!)
      investigatorIDs.push(result.agents[0]!)
    }
  }
  for (const investigator of investigatorIDs) {
    for (let i = 0; i < Math.min(10, Math.ceil(population / 12)); i++) {
      const role = i % 4 === 3 ? "flaky" : i % 5 === 2 ? "reviewer" : "implementer"
      const result = runtime.spawn(investigator, { missionID: mission.id, role })
      if (result.type === "spawned") spawned.push(result.agents[0]!)
    }
  }
  // Budget-increase request from the first implementer.
  const firstImplementer = spawned.find((id) => runtime.state.agents.get(id)?.info.role === "implementer")
  if (firstImplementer !== undefined) {
    runtime.requestBudgetIncrease({
      agentID: firstImplementer,
      reason: "deep regression investigation is spending more calls than planned",
      requested: { max_model_calls: 1000, max_tokens: 500_000 },
    })
  }

  // Run a few ticks so some agents complete and some queue behind the bound.
  const ticks = opts.ticks ?? 3
  for (let i = 0; i < ticks; i++) {
    await runtime.runOnce()
  }
  return runtime
}

export async function createDemoBridge(opts: DemoOptions & { tickIntervalMs?: number } = {}): Promise<SwarmBridge> {
  const runtime = await createDemoRuntime(opts)
  const primary = [...runtime.state.agents.values()].find((a) => a.info.depth === 0)
  const missionID = [...runtime.state.missions.keys()][0]
  let spawnedTotal = 0
  const populationCap = Math.max((opts.population ?? 300) * 3, 800)
  return new SwarmBridge(runtime, {
    tickIntervalMs: opts.tickIntervalMs,
    // Keep the demo alive: every tick, top the queue back up so the operator
    // sees queued work instead of a fully-drained swarm.
    onTick: () => {
      if (primary === undefined || missionID === undefined) return
      if (spawnedTotal >= populationCap) return
      const queued = runtime.state.accounts.population
      if (queued >= 40) return
      const batch = Math.min(48, populationCap - spawnedTotal)
      for (let i = 0; i < batch; i++) {
        const result = runtime.spawn(primary.info.id, { missionID, role: i % 3 === 0 ? "implementer" : i % 3 === 1 ? "investigator" : "reviewer" })
        if (result.type === "spawned") spawnedTotal++
      }
    },
  })
}

// Fast population seed for perf tests: spawn a full tree without running it,
// so the snapshot + tree logic is exercised against a large queued swarm.
export function seedPopulation(runtime: SwarmRuntime, missionID: string, primaryID: SwarmAgent.ID, count: number): void {
  const queue: Array<{ parent: SwarmAgent.ID; depth: number }> = [{ parent: primaryID, depth: 0 }]
  let spawned = 0
  const childrenPerAgent = 50
  while (queue.length > 0 && spawned < count) {
    const node = queue.shift()!
    const childDepth = node.depth + 1
    const toSpawn = Math.min(childrenPerAgent, count - spawned)
    for (let i = 0; i < toSpawn; i++) {
      const role = childDepth <= 1 ? "investigator" : childDepth === 2 ? "implementer" : "reviewer"
      const result = runtime.spawn(node.parent, { missionID, role })
      if (result.type !== "spawned") return
      spawned++
      if (childDepth < 6) queue.push({ parent: result.agents[0]!, depth: childDepth })
    }
  }
}
