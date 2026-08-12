import { describe, expect, test } from "bun:test"
import { SwarmGovernor } from "../src/policy/governor"
import { SwarmConfig } from "../src/config/config"
import { SwarmProvider } from "../src/provider/provider"
import { SwarmWorkspace } from "../src/workspace/workspace"
import { SwarmAgent } from "../src/agent/agent"
import { SwarmRuntime } from "../src/runtime/runtime"
import { SwarmClusterSim } from "../src/simulation/cluster-simulation"

const baseConfig = (models: Partial<SwarmConfig.ModelsConfig> = {}): SwarmConfig.Info => ({
  enabled: true,
  max_agents: 500,
  max_active_agents: 16,
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
    ...models,
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
})

describe("SwarmGovernor (pure)", () => {
  test("global concurrency caps concurrent reservations", () => {
    const state = SwarmGovernor.emptyGovernorState()
    const limits: SwarmGovernor.GovernorLimits = { globalConcurrent: 2 }
    const req = { model: "fake/echo", provider: "fake", now: 1 }
    expect(SwarmGovernor.tryReserve(state, limits, req).kind).toBe("allow")
    expect(SwarmGovernor.tryReserve(state, limits, req).kind).toBe("allow")
    const third = SwarmGovernor.tryReserve(state, limits, req)
    expect(third.kind).toBe("queue")
    if (third.kind === "queue") expect(third.code).toBe("global_concurrency")
    SwarmGovernor.release(state, req)
    expect(SwarmGovernor.tryReserve(state, limits, req).kind).toBe("allow")
  })

  test("model concurrency caps per-model reservations", () => {
    const state = SwarmGovernor.emptyGovernorState()
    const limits: SwarmGovernor.GovernorLimits = { model: { "fake/echo": { concurrency: 1 } } }
    const req = { model: "fake/echo", provider: "fake", now: 1 }
    expect(SwarmGovernor.tryReserve(state, limits, req).kind).toBe("allow")
    const second = SwarmGovernor.tryReserve(state, limits, req)
    expect(second.kind).toBe("queue")
    if (second.kind === "queue") expect(second.code).toBe("model_concurrency")
  })

  test("provider concurrency caps across all its models", () => {
    const state = SwarmGovernor.emptyGovernorState()
    const limits: SwarmGovernor.GovernorLimits = { provider: { fake: { concurrency: 1 } } }
    expect(SwarmGovernor.tryReserve(state, limits, { model: "fake/a", provider: "fake", now: 1 }).kind).toBe("allow")
    const second = SwarmGovernor.tryReserve(state, limits, { model: "fake/b", provider: "fake", now: 2 })
    expect(second.kind).toBe("queue")
    if (second.kind === "queue") expect(second.code).toBe("provider_concurrency")
  })

  test("requests-per-window window limits burst traffic and cools down", () => {
    const state = SwarmGovernor.emptyGovernorState()
    const limits: SwarmGovernor.GovernorLimits = { model: { "fake/echo": { requestsPerWindow: 2, windowMs: 100 } } }
    expect(SwarmGovernor.tryReserve(state, limits, { model: "fake/echo", provider: "fake", now: 0 }).kind).toBe("allow")
    expect(SwarmGovernor.tryReserve(state, limits, { model: "fake/echo", provider: "fake", now: 10 }).kind).toBe("allow")
    const burst = SwarmGovernor.tryReserve(state, limits, { model: "fake/echo", provider: "fake", now: 20 })
    expect(burst.kind).toBe("queue")
    if (burst.kind === "queue") {
      expect(burst.code).toBe("rate_limited")
      expect(burst.backoffMs).toBeGreaterThanOrEqual(80)
    }
    // After the window passes, reservations resume.
    expect(SwarmGovernor.tryReserve(state, limits, { model: "fake/echo", provider: "fake", now: 200 }).kind).toBe("allow")
  })

  test("token throughput window blocks once exhausted", () => {
    const state = SwarmGovernor.emptyGovernorState()
    const limits: SwarmGovernor.GovernorLimits = { model: { "fake/echo": { tokensPerWindow: 100, windowMs: 1000 } } }
    const req = { model: "fake/echo", provider: "fake" }
    SwarmGovernor.recordTokens(state, { ...req, tokens: 120, now: 0 })
    const denied = SwarmGovernor.tryReserve(state, limits, { ...req, now: 10 })
    expect(denied.kind).toBe("queue")
    if (denied.kind === "queue") expect(denied.code).toBe("tokens_exhausted")
    // Old token entries expire out of the window.
    const allowed = SwarmGovernor.tryReserve(state, limits, { ...req, now: 5000 })
    expect(allowed.kind).toBe("allow")
  })

  test("no declared limits never throttles", () => {
    const state = SwarmGovernor.emptyGovernorState()
    for (let i = 0; i < 100; i++) {
      expect(SwarmGovernor.tryReserve(state, {}, { model: "fake/echo", provider: "fake", now: i }).kind).toBe("allow")
    }
  })
})

describe("rate-limit backpressure (local runtime)", () => {
  // An advancing clock lets the governor backoff expire between scheduler
  // ticks, exactly like wall-clock time in production.
  function makeClock() {
    let t = 1_700_000_000_000
    return { now: () => (t += 10), at: t }
  }

  test("a throttled agent is QUEUED with backoff, never hard-failed, and resumes after release", async () => {
    // Global concurrency of 1 with two agents: the second must wait, then run
    // once the first finishes.
    const config = baseConfig({ global_concurrency: 1 })
    const provider = SwarmProvider.makeFakeProvider({
      fallback: (_req, step) => (step === 0 ? [{ delta: "x", tokens: 4, finish: "stop" }] : [{ finish: "stop" }]),
    })
    const clock = makeClock()
    const rt = new SwarmRuntime({ config, provider, workspace: SwarmWorkspace.fakeBackend(), now: clock.now })
    const primary = SwarmAgent.ID.create()
    const mission = rt.createMission({ title: "rl", brief: "b", primaryAgentID: primary })
    rt.registerPrimary({ missionID: mission.id, agentID: primary })
    const a = rt.spawn(primary, { missionID: mission.id, role: "echo" })
    const b = rt.spawn(primary, { missionID: mission.id, role: "echo" })
    expect(a.type).toBe("spawned")
    expect(b.type).toBe("spawned")

    await rt.runToFixedPoint(200)

    // Both agents completed; the global concurrency cap was never exceeded.
    const states = [...rt.state.agents.values()].map((r) => r.info.state)
    expect(states.filter((s) => s === "completed").length).toBeGreaterThanOrEqual(2)
    expect(SwarmGovernor.globalActive(rt.state.governor)).toBe(0)
  })

  test("a model concurrency limit queues excess agents instead of failing them", async () => {
    const config = baseConfig({ limits: { "fake/echo": { concurrency: 1 } } })
    const provider = SwarmProvider.makeFakeProvider({
      fallback: (_req, step) => (step === 0 ? [{ delta: "x", tokens: 4, finish: "stop" }] : [{ finish: "stop" }]),
    })
    const clock = makeClock()
    const rt = new SwarmRuntime({ config, provider, workspace: SwarmWorkspace.fakeBackend(), now: clock.now })
    const primary = SwarmAgent.ID.create()
    const mission = rt.createMission({ title: "rl", brief: "b", primaryAgentID: primary })
    rt.registerPrimary({ missionID: mission.id, agentID: primary })
    for (let i = 0; i < 4; i++) rt.spawn(primary, { missionID: mission.id, role: "echo" })

    await rt.runToFixedPoint(200)

    const failed = [...rt.state.agents.values()].filter((r) => r.info.state === "failed").length
    const completed = [...rt.state.agents.values()].filter((r) => r.info.state === "completed").length
    // No agent was hard-failed by throttling; all eventually completed.
    expect(failed).toBe(0)
    expect(completed).toBe(4)
  })
})

describe("rate-limit backpressure (cluster harness)", () => {
  // Tracks the real number of overlapping streams. The decrement lives in a
  // finally so it runs even when the consumer breaks out of the for-await.
  function trackingProvider(counter: { concurrent: number; peak: number }): () => SwarmProvider.Provider {
    return () => ({
      async *stream() {
        counter.concurrent += 1
        counter.peak = Math.max(counter.peak, counter.concurrent)
        try {
          await Bun.sleep(1)
          yield { finish: "stop", tokens: 4 }
        } finally {
          counter.concurrent -= 1
        }
      },
    })
  }

  test("global concurrent LLM calls hold across workers", async () => {
    const counter = { concurrent: 0, peak: 0 }
    const sim = await SwarmClusterSim.runClusterSim({
      population: 80,
      activeBound: 12,
      workspaceBound: 4,
      childrenPerAgent: 50,
      maxDepth: 3,
      workerCount: 4,
      maxConcurrentPerWorker: 4,
      llmCap: 6,
      provider: trackingProvider(counter),
      clockStepMs: 1,
    })
    expect(counter.peak).toBeLessThanOrEqual(6)
    const accounting = await sim.store.accounting()
    expect(accounting.activeLLMPeak).toBeLessThanOrEqual(6)
  })

  test("per-model concurrency cap never exceeds its limit across workers", async () => {
    const counter = { concurrent: 0, peak: 0 }
    const modelCap = 2
    const sim = await SwarmClusterSim.runClusterSim({
      population: 60,
      activeBound: 12,
      workspaceBound: 4,
      childrenPerAgent: 50,
      maxDepth: 3,
      workerCount: 4,
      maxConcurrentPerWorker: 4,
      llmCap: 20,
      modelLimits: { "fake/echo": { concurrency: modelCap } },
      provider: trackingProvider(counter),
      clockStepMs: 1,
    })
    // The governor reservation is per model; the tracking provider sees the
    // effective concurrency cap regardless of how many workers claim leases.
    expect(counter.peak).toBeLessThanOrEqual(modelCap)
    const accounting = await sim.store.accounting()
    expect(accounting.activeLLMPeak).toBeLessThanOrEqual(20)
  })
})
