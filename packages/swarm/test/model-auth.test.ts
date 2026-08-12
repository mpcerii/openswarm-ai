import { describe, expect, test } from "bun:test"
import { SwarmConfig } from "../src/config/config"
import { SwarmRuntime } from "../src/runtime/runtime"
import { SwarmProvider } from "../src/provider/provider"
import { SwarmWorkspace } from "../src/workspace/workspace"
import { SwarmAgent } from "../src/agent/agent"
import { SwarmAudit } from "../src/audit/audit"
import { SwarmControl } from "../src/control/control"
import { SwarmModelHealth } from "../src/models/health"
import { MemoryStore } from "../src/storage/memory"

const cfg = (overrides: Partial<SwarmConfig.Info> = {}): SwarmConfig.Info => ({
  enabled: true,
  max_agents: 200,
  max_active_agents: 8,
  max_active_coding_workspaces: 4,
  max_depth: 4,
  max_children_per_agent: 50,
  models: {
    allowed: ["fake/echo", "fake/opus"],
    pools: { cheap: ["fake/echo"], expensive: ["fake/opus"] },
    catalog: {
      "fake/echo": { context_window: 8000, capabilities: { tools: true }, priority: 1 },
      "fake/opus": { context_window: 200000, capabilities: { tools: true, reasoning: true }, priority: 9 },
    },
    routing: { policy: "prefer-cheapest" },
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

function makeRuntime(overrides: Partial<SwarmConfig.Info> = {}, config?: SwarmConfig.Info) {
  const provider = SwarmProvider.makeFakeProvider({ fallback: () => [{ finish: "stop" }] })
  const rt = new SwarmRuntime({
    config: config ?? cfg(overrides),
    provider,
    workspace: SwarmWorkspace.fakeBackend(),
    now: () => 1_700_000_000_000,
  })
  const primary = SwarmAgent.ID.create()
  const mission = rt.createMission({ title: "auth", brief: "b", primaryAgentID: primary })
  rt.registerPrimary({ missionID: mission.id, agentID: primary })
  return { rt, provider, primary, mission }
}

describe("model authorization security (local runtime)", () => {
  test("an unauthorized model request is rejected and NEVER reaches the provider", async () => {
    const { rt, provider, primary, mission } = makeRuntime()
    const result = rt.spawn(primary, { missionID: mission.id, role: "investigator", model: "anthropic/claude-opus" })
    expect(result.type).toBe("rejected")
    if (result.type === "rejected") expect(result.code).toBe("model_not_allowed")
    await rt.runToFixedPoint(5)
    // No provider call ever happened: the unauthorized model never executed.
    expect(provider.historicCalls.length).toBe(0)
  })

  test("empty allowlist is fail-closed even when a pool is requested", () => {
    const { rt, primary, mission } = makeRuntime({ models: { ...cfg().models, allowed: [] } })
    const result = rt.spawn(primary, { missionID: mission.id, role: "investigator", pool: "cheap" })
    expect(result.type).toBe("rejected")
    if (result.type === "rejected") expect(result.code).toBe("no_models_allowed")
  })

  test("a pool referencing a non-allowed model resolves empty (never auto-added)", () => {
    const { rt, primary, mission } = makeRuntime({ models: { ...cfg().models, allowed: ["fake/echo"], pools: { sneaky: ["unlisted/model"] } } })
    const result = rt.spawn(primary, { missionID: mission.id, role: "investigator", pool: "sneaky" })
    expect(result.type).toBe("rejected")
    if (result.type === "rejected") expect(result.code).toBe("pool_empty")
  })

  test("spawns only ever use allowlist-resolved models, never caller-provided ones", async () => {
    const { rt, primary, mission } = makeRuntime()
    const result = rt.spawn(primary, { missionID: mission.id, role: "investigator", pool: "cheap" })
    expect(result.type).toBe("spawned")
    if (result.type !== "spawned") return
    const agentID = result.agents[0]!
    await rt.runToFixedPoint(5)
    const record = rt.state.agents.get(agentID)!
    expect(record.info.resolvedModel).toBeDefined()
    expect(["fake/echo", "fake/opus"]).toContain(record.info.resolvedModel!)
  })

  test("fallback moves to another authorized model, never to an unauthorized one", async () => {
    const { rt, provider, primary, mission } = makeRuntime()
    // Rate-limit the only authorized model in the cheap pool: routing falls
    // back to the OTHER human-authorized model (fake/opus), never to an
    // unlisted model the provider might advertise.
    SwarmModelHealth.markHealth(rt.state.health, "fake/echo", "rate_limited", 1_700_000_000_000, 10_000)
    const result = rt.spawn(primary, { missionID: mission.id, role: "investigator", pool: "cheap" })
    expect(result.type).toBe("spawned")
    if (result.type === "spawned") {
      const agentID = result.agents[0]!
      const record = rt.state.agents.get(agentID)!
      expect(record.info.resolvedModel).toBe("fake/opus")
      // Every recorded provider call used only authorized models.
      await rt.runToFixedPoint(5)
      for (const call of provider.historicCalls) {
        expect(cfg().models.allowed).toContain(call.model)
      }
    }
  })

  test("model.selected audit events carry operational routing reasons", async () => {
    const { rt, primary, mission } = makeRuntime()
    const result = rt.spawn(primary, { missionID: mission.id, role: "investigator", capability: "reasoning" })
    expect(result.type).toBe("spawned")
    const selected = SwarmAudit.forType(rt.state.audit, "swarm.model.selected")
    expect(selected.length).toBeGreaterThanOrEqual(1)
    const data = selected[0]!.data as Record<string, unknown>
    expect(data.model).toBe("fake/opus")
    expect(data.reason).toBeTruthy()
  })

  test("a resolved model that is no longer authorized fails instead of executing (defense-in-depth)", async () => {
    const config = cfg()
    const { rt, provider, primary, mission } = makeRuntime({}, config)
    const result = rt.spawn(primary, { missionID: mission.id, role: "investigator" })
    expect(result.type).toBe("spawned")
    const agentID = result.type === "spawned" ? result.agents[0]! : ""
    // Simulate the human removing the model from the allowlist mid-mission.
    ;(config.models as { allowed: string[] }).allowed = []
    await rt.runToFixedPoint(5)
    const record = rt.state.agents.get(agentID)
    expect(record?.info.state).toBe("failed")
    expect(provider.historicCalls.filter((c) => c.agentID === agentID).length).toBe(0)
  })
})

describe("model authorization security (control plane)", () => {
  test("an unauthorized spawn is rejected by the control plane before any worker", async () => {
    const store = new MemoryStore({ max_agents: 200, max_active_agents: 8, max_depth: 4, max_children_per_agent: 50 }, 16, 4)
    const control = new SwarmControl.ControlPlane({ store, config: cfg(), now: () => 1_700_000_000_000 })
    const primary = SwarmAgent.ID.create()
    const mission = await control.createMission({ title: "auth", brief: "b", primaryAgentID: primary })
    await control.registerPrimary({ missionID: mission.id, agentID: primary })
    const result = await control.spawn(primary, { missionID: mission.id, role: "investigator", model: "anthropic/claude-opus" })
    expect(result.type).toBe("rejected")
    if (result.type === "rejected") expect(result.code).toBe("model_not_allowed")
  })

  test("control plane models view marks authorization from the allowlist only", async () => {
    const store = new MemoryStore({ max_agents: 200, max_active_agents: 8, max_depth: 4, max_children_per_agent: 50 }, 16, 4)
    const control = new SwarmControl.ControlPlane({ store, config: cfg(), now: () => 1_700_000_000_000 })
    const view = await control.modelsView()
    expect(view.entries.length).toBe(2)
    for (const entry of view.entries) {
      expect(entry.authorized).toBe(true)
      expect(entry.pools.length).toBeGreaterThanOrEqual(1)
    }
  })
})
