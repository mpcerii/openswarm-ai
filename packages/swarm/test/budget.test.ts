import { describe, expect, test } from "bun:test"
import { SwarmConfig } from "../src/config/config"
import { SwarmRuntime } from "../src/runtime/runtime"
import { SwarmProvider } from "../src/provider/provider"
import { SwarmWorkspace } from "../src/workspace/workspace"
import { SwarmAgent } from "../src/agent/agent"
import { SwarmAudit } from "../src/audit/audit"
import { SwarmMissionBudget } from "../src/policy/mission-budget"
import { SwarmChildBudget } from "../src/policy/child-budget"
import { SwarmControl } from "../src/control/control"
import { MemoryStore } from "../src/storage/memory"
import { SwarmClusterSim } from "../src/simulation/cluster-simulation"

const cfg = (overrides: Partial<SwarmConfig.Info> = {}): SwarmConfig.Info => ({
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
  budget: { default: undefined, soft_ratio: 0.5 },
  ...overrides,
})

function makeRuntime(missionBudget: SwarmConfig.MissionBudget, overrides: Partial<SwarmConfig.Info> = {}) {
  const provider = SwarmProvider.makeFakeProvider({ fallback: (_req, step) => (step === 0 ? [{ delta: "x", tokens: 4, finish: "stop" }] : [{ finish: "stop" }]) })
  const rt = new SwarmRuntime({
    config: cfg({ budget: { default: missionBudget, soft_ratio: 0.5 }, ...overrides }),
    provider,
    workspace: SwarmWorkspace.fakeBackend(),
    now: () => 1_700_000_000_000,
  })
  const primary = SwarmAgent.ID.create()
  const mission = rt.createMission({ title: "budget", brief: "b", primaryAgentID: primary, budget: missionBudget })
  rt.registerPrimary({ missionID: mission.id, agentID: primary })
  return { rt, provider, primary, mission }
}

describe("SwarmMissionBudget (pure)", () => {
  test("hard limit stops consumption and soft threshold warns", () => {
    const state = SwarmMissionBudget.makeState("m1", { max_model_calls: 4 }, 0)
    const ratio = 0.5
    expect(SwarmMissionBudget.evaluate(state, 0, ratio)).toBe("ok")
    for (let i = 0; i < 4; i++) SwarmMissionBudget.tryConsumeCall(state)
    expect(SwarmMissionBudget.evaluate(state, 0, ratio)).toBe("hard")
    expect(SwarmMissionBudget.tryConsumeCall(state)).toBe(false)
  })

  test("human increase clears the hard flag so scheduling can resume", () => {
    const state = SwarmMissionBudget.makeState("m1", { max_model_calls: 2 }, 0)
    SwarmMissionBudget.tryConsumeCall(state)
    SwarmMissionBudget.tryConsumeCall(state)
    SwarmMissionBudget.markHard(state)
    expect(SwarmMissionBudget.evaluate(state, 0, 0.8)).toBe("hard")
    SwarmMissionBudget.increaseLimits(state, { max_model_calls: 5 })
    expect(state.hardReached).toBe(false)
    expect(SwarmMissionBudget.tryConsumeCall(state)).toBe(true)
  })
})

describe("SwarmChildBudget (pure)", () => {
  test("delegation cannot exceed the parent's remaining allocation", () => {
    const remaining = { modelCalls: 100, tokens: 1000, cost: 0 }
    const a = SwarmChildBudget.delegate(remaining, { modelCalls: 40 })
    const b = a.ok ? SwarmChildBudget.delegate(a.remaining, { modelCalls: 40 }) : { ok: false as const, code: "insufficient_budget" as const }
    const c = b.ok ? SwarmChildBudget.delegate(b.remaining, { modelCalls: 30 }) : { ok: false as const, code: "insufficient_budget" as const }
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(c.ok).toBe(false)
    if (a.ok && b.ok && !c.ok) {
      expect(b.remaining.modelCalls).toBe(20)
    }
  })

  test("reclaim returns a child's unused allocation to the parent", () => {
    const parent = { modelCalls: 100, tokens: 1000, cost: 0 }
    const d = SwarmChildBudget.delegate(parent, { modelCalls: 30 })
    if (!d.ok) throw new Error("delegation failed")
    // The child consumed 20 of its 30; 10 remain unused.
    const unused: SwarmChildBudget.ChildAllocation = { modelCalls: 10, tokens: d.allocation.tokens, cost: d.allocation.cost }
    const back = SwarmChildBudget.reclaim(d.remaining, unused)
    expect(back.modelCalls).toBe(80)
  })
})

describe("mission budgets (local runtime)", () => {
  test("hard call limit stops scheduling new work; agents wait, state is preserved", async () => {
    const { rt, provider, primary, mission } = makeRuntime({ max_model_calls: 2 }, { max_active_agents: 1 })
    for (let i = 0; i < 4; i++) rt.spawn(primary, { missionID: mission.id, role: "echo" })
    await rt.runToFixedPoint(50)
    const states = [...rt.state.agents.values()].map((r) => r.info.state)
    // Exactly the hard limit of calls ran; the rest wait in the queue.
    expect(states.filter((s) => s === "completed").length).toBe(2)
    expect(states.filter((s) => s === "queued").length).toBe(2)
    // No task state was half-mutated: queued agents were never admitted.
    expect(provider.historicCalls.length).toBe(2)
    const hardEvents = SwarmAudit.forType(rt.state.audit, "swarm.budget.hard_reached")
    expect(hardEvents.length).toBeGreaterThanOrEqual(1)
  })

  test("soft threshold warns the mission once", async () => {
    const { rt, primary, mission } = makeRuntime({ max_model_calls: 10 }, { max_active_agents: 1 })
    for (let i = 0; i < 6; i++) rt.spawn(primary, { missionID: mission.id, role: "echo" })
    await rt.runToFixedPoint(50)
    const warned = SwarmAudit.forType(rt.state.audit, "swarm.budget.warned")
    expect(warned.length).toBe(1)
  })

  test("human budget increase resumes the mission", async () => {
    const { rt, primary, mission } = makeRuntime({ max_model_calls: 2 }, { max_active_agents: 1 })
    for (let i = 0; i < 4; i++) rt.spawn(primary, { missionID: mission.id, role: "echo" })
    await rt.runToFixedPoint(50)
    expect([...rt.state.agents.values()].filter((r) => r.info.state === "completed").length).toBe(2)

    // The primary requests more budget; the human approves.
    const req = rt.requestBudgetIncrease({ agentID: primary, reason: "need more calls", requested: { max_model_calls: 10 } })
    expect(req).toBeDefined()
    if (req !== undefined) rt.resolveBudgetIncrease(req.id, "approve", { max_model_calls: 10 })
    await rt.runToFixedPoint(50)
    expect([...rt.state.agents.values()].filter((r) => r.info.state === "completed").length).toBe(4)
  })

  test("an agent cannot approve its own budget increase", () => {
    const { rt, primary, mission } = makeRuntime({ max_model_calls: 2 })
    const req = rt.requestBudgetIncrease({ agentID: primary, reason: "more" })
    expect(req).toBeDefined()
    if (req === undefined) return
    // The request stays open for the human; there is no agent-side approve.
    expect(rt.state.openApprovals.has(req.id)).toBe(true)
    // A rejected increase changes nothing.
    rt.resolveBudgetIncrease(req.id, "reject")
    expect([...rt.state.agents.values()].filter((r) => r.info.state === "completed").length).toBe(0)
  })

  test("child budgets cannot duplicate the parent's finite allocation", async () => {
    const { rt, primary, mission } = makeRuntime({ max_model_calls: 100 }, { max_active_agents: 2 })
    const a = rt.spawn(primary, { missionID: mission.id, role: "backend", budget: { model_calls: 40 } })
    const b = rt.spawn(primary, { missionID: mission.id, role: "frontend", budget: { model_calls: 40 } })
    const c = rt.spawn(primary, { missionID: mission.id, role: "security", budget: { model_calls: 30 } })
    expect(a.type).toBe("spawned")
    expect(b.type).toBe("spawned")
    expect(c.type).toBe("rejected")
    if (c.type === "rejected") expect(c.code).toBe("budget_exhausted")
    // The parent's remaining = 100 - 40 - 40 = 20 (never minted).
    const parentAllocation = rt.state.agentBudgets.get(primary)!
    expect(parentAllocation.modelCalls).toBe(20)
  })

  test("a completed child returns its unused allocation to the parent", async () => {
    const { rt, primary, mission } = makeRuntime({ max_model_calls: 100 }, { max_active_agents: 2 })
    const a = rt.spawn(primary, { missionID: mission.id, role: "backend", budget: { model_calls: 40 } })
    expect(a.type).toBe("spawned")
    const childID = a.type === "spawned" ? a.agents[0]! : ""
    await rt.runToFixedPoint(20)
    // The child ran once (consumed 1 call) then reclaimed 39 to the parent.
    const childAllocation = rt.state.agentBudgets.get(childID)
    expect(childAllocation).toBeUndefined()
    const parentAllocation = rt.state.agentBudgets.get(primary)!
    expect(parentAllocation.modelCalls).toBe(99)
  })
})

describe("mission budgets (cluster harness, atomic across workers)", () => {
  test("hard call limit is enforced exactly once across workers", async () => {
    const limit = 5
    const sim = await SwarmClusterSim.runClusterSim({
      population: 40,
      activeBound: 8,
      workspaceBound: 4,
      childrenPerAgent: 50,
      maxDepth: 3,
      workerCount: 3,
      maxConcurrentPerWorker: 4,
      llmCap: 20,
      missionBudget: { max_model_calls: limit },
      clockStepMs: 2,
    })
    const mission = (await sim.store.listMissions())[0]!
    const accounting = await sim.store.missionAccounting(mission.id)
    expect(accounting).toBeDefined()
    if (accounting !== undefined) {
      // In-flight overrun is bounded by the active bound; no further leases
      // were issued once the limit was reached.
      expect(accounting.used_calls).toBeGreaterThanOrEqual(limit)
      expect(accounting.used_calls).toBeLessThanOrEqual(limit + 8)
    }
  })

  test("child budget delegation is atomic and cannot duplicate across the store", async () => {
    const store = new MemoryStore({ max_agents: 500, max_active_agents: 16, max_depth: 4, max_children_per_agent: 100 }, 20, 4)
    const config = cfg()
    const control = new SwarmControl.ControlPlane({ store, config, now: () => 1_700_000_000_000 })
    const primary = SwarmAgent.ID.create()
    const mission = await control.createMission({ title: "budget", brief: "b", primaryAgentID: primary, budget: { max_model_calls: 100 } })
    await control.registerPrimary({ missionID: mission.id, agentID: primary })
    const a = await control.spawn(primary, { missionID: mission.id, role: "backend", budget: { model_calls: 40 } })
    const b = await control.spawn(primary, { missionID: mission.id, role: "frontend", budget: { model_calls: 40 } })
    const c = await control.spawn(primary, { missionID: mission.id, role: "security", budget: { model_calls: 30 } })
    expect(a.type).toBe("spawned")
    expect(b.type).toBe("spawned")
    expect(c.type).toBe("rejected")
    if (c.type === "rejected") expect(c.code).toBe("budget_exhausted")
    const parentRemaining = await store.atomicAgentBudgetRemaining(primary)
    expect(parentRemaining?.model_calls).toBe(20)
    const childRemaining = await store.atomicAgentBudgetRemaining(a.type === "spawned" ? a.agents[0]! : "")
    expect(childRemaining?.model_calls).toBe(40)
  })
})
