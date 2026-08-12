import { describe, expect, test } from "bun:test"
import { SwarmConfig } from "../src/config/config"
import { SwarmRuntime } from "../src/runtime/runtime"
import { SwarmProvider } from "../src/provider/provider"
import { SwarmWorkspace } from "../src/workspace/workspace"
import { SwarmAgent } from "../src/agent/agent"
import { SwarmModelCatalog } from "../src/models/catalog"
import { SwarmModelHealth } from "../src/models/health"
import { SwarmModelRouter } from "../src/router/router"
import { SwarmAudit } from "../src/audit/audit"
import { SwarmClusterSim } from "../src/simulation/cluster-simulation"

const stressConfig = (overrides: Partial<SwarmConfig.Info> = {}): SwarmConfig.Info => ({
  enabled: true,
  max_agents: 6000,
  max_active_agents: 64,
  max_active_coding_workspaces: 16,
  max_depth: 4,
  max_children_per_agent: 6000,
  models: {
    allowed: ["fake/cheap", "fake/flash", "fake/opus", "fake/vision"],
    pools: {
      cheap: ["fake/cheap", "fake/flash"],
      coding: ["fake/flash", "fake/opus"],
      review: ["fake/flash"],
      vision: ["fake/vision"],
    },
    catalog: {
      "fake/cheap": { priority: 1, latency_ms: 40, context_window: 8000, capabilities: { tools: true } },
      "fake/flash": { priority: 2, latency_ms: 20, context_window: 16000, capabilities: { tools: true } },
      "fake/opus": { priority: 5, latency_ms: 200, context_window: 200000, capabilities: { tools: true, reasoning: true } },
      "fake/vision": { priority: 4, latency_ms: 100, context_window: 128000, capabilities: { vision: true } },
    },
    routing: { policy: "balanced" },
    limits: undefined,
    providers: undefined,
    global_concurrency: undefined,
    mission_token_budget: undefined,
  },
  approval: {
    spawn: "allow",
    workspace_write: "allow",
    dependency_change: "ask",
    git_commit: "ask",
    git_push: "ask",
    merge: "ask",
    external_side_effect: "ask",
    mission_plan: "ask",
    integration: "ask",
    budget_increase: "ask",
  },
  budget: { default: undefined, soft_ratio: 0.8 },
  ...overrides,
})

describe("router stress (pure, no LLM)", () => {
  test("50k routing decisions stay fast, deterministic and always authorized", () => {
    const config = stressConfig()
    const catalog = SwarmModelCatalog.buildCatalog(config)
    const health = SwarmModelHealth.emptyHealthState()
    const pools = ["cheap", "coding", "review", "vision", undefined]
    const caps = ["text", "tools", "vision", "reasoning", "large-context", undefined]
    const started = Date.now()
    let ok = 0
    let failed = 0
    for (let i = 0; i < 50_000; i++) {
      const ctx: SwarmModelRouter.RoutingContext = {
        policy: i % 4 === 0 ? "prefer-cheapest" : i % 4 === 1 ? "prefer-lowest-latency" : i % 4 === 2 ? "prefer-strongest" : "balanced",
        catalog,
        pools: config.models.pools,
        health,
        now: 1_700_000_000_000 + i,
        concurrency: new Map(),
        providerConcurrency: new Map(),
        limits: undefined,
        providerLimits: undefined,
      }
      const result = SwarmModelRouter.route(ctx, {
        requestedPool: pools[i % pools.length],
        requestedCapability: caps[i % caps.length],
        contextSize: i % 3 === 0 ? 20_000 : undefined,
      })
      if (result.ok) {
        ok += 1
        // The router can only ever select a human-authorized model.
        expect(config.models.allowed).toContain(result.model)
        expect(result.fallbackOrder.every((m) => config.models.allowed.includes(m))).toBe(true)
      } else {
        failed += 1
        expect(["pool_not_found", "pool_empty", "no_models_allowed", "no_eligible_model", "context_overflow", "rate_limited", "no_remaining_budget"]).toContain(result.code)
      }
    }
    const wallMs = Date.now() - started
    // Both paths were exercised and throughput is healthy.
    expect(ok).toBeGreaterThan(30_000)
    expect(failed).toBeGreaterThan(5_000)
    expect(wallMs).toBeLessThan(5_000)
  })
})

describe("routing at logical-agent scale (no paid LLM)", () => {
  test("5,000 simulated logical agents each get an authorized routed model", async () => {
    const config = stressConfig()
    const provider = SwarmProvider.makeFakeProvider({ fallback: () => [{ finish: "stop" }] })
    const rt = new SwarmRuntime({ config, provider, workspace: SwarmWorkspace.fakeBackend(), now: () => Date.now() })
    const primary = SwarmAgent.ID.create()
    const mission = rt.createMission({ title: "routing stress", brief: "b", primaryAgentID: primary })
    rt.registerPrimary({ missionID: mission.id, agentID: primary })

    const pools = ["cheap", "coding", "review", "vision"]
    const caps = ["reasoning", "vision", "tools"]
    const started = Date.now()
    for (let i = 0; i < 5000; i++) {
      // Alternate pool-only and capability-only requests; both are well-formed
      // so the router must resolve every one to an authorized model.
      const result = rt.spawn(primary, {
        missionID: mission.id,
        role: `worker:${i % 4}`,
        ...(i % 2 === 0 ? { pool: pools[i % pools.length] } : { capability: caps[i % caps.length] }),
      })
      expect(result.type).toBe("spawned")
    }
    const spawnMs = Date.now() - started

    await rt.runToFixedPoint(400)

    const agents = [...rt.state.agents.values()].filter((r) => r.info.id !== primary)
    expect(agents.length).toBe(5000)
    // Every agent ran on a human-authorized model.
    for (const record of agents) {
      expect(record.info.resolvedModel).toBeDefined()
      expect(config.models.allowed).toContain(record.info.resolvedModel!)
    }
    // Every spawn produced a model.selected audit event (observability).
    const selected = SwarmAudit.forType(rt.state.audit, "swarm.model.selected")
    expect(selected.length).toBe(5000)
    // No paid LLM traffic: the fake provider saw every run but nothing failed.
    const failed = agents.filter((r) => r.info.state === "failed").length
    expect(failed).toBe(0)
    console.log("[router-stress]", { population: agents.length, spawnMs, completed: agents.filter((a) => a.info.state === "completed").length })
  }, 60_000)
})

describe("routing at cluster scale (control plane)", () => {
  test("2,000 agents route through the control plane across workers", async () => {
    const sim = await SwarmClusterSim.runClusterSim({
      population: 2000,
      activeBound: 32,
      workspaceBound: 8,
      childrenPerAgent: 100,
      maxDepth: 4,
      workerCount: 4,
      maxConcurrentPerWorker: 8,
      llmCap: 32,
      allowedModels: ["fake/echo"],
      clockStepMs: 1,
    })
    const agents = await sim.store.listAgents()
    const nonPrimary = agents.filter((a) => a.id !== sim.primaryID)
    expect(nonPrimary.length).toBeGreaterThanOrEqual(1900)
    for (const agent of nonPrimary) {
      expect(agent.resolvedModel).toBe("fake/echo")
      expect(SwarmAgent.isDone(agent.state)).toBe(true)
    }
    const selected = await sim.store.eventsByType("swarm.model.selected")
    expect(selected.length).toBeGreaterThanOrEqual(1900)
  }, 60_000)
})
