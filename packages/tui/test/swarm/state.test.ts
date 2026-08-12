import { expect, test } from "bun:test"
import { SwarmRuntime } from "@opencode-ai/swarm/runtime/runtime"
import { SwarmAgent } from "@opencode-ai/swarm/agent/agent"
import { SwarmWorkspace } from "@opencode-ai/swarm/workspace/workspace"
import { SwarmProvider } from "@opencode-ai/swarm/provider/provider"
import { SwarmConfig } from "@opencode-ai/swarm/config/config"
import { buildSnapshot } from "../../src/swarm/state/snapshot"
import { visibleTree, expansionPath, pageForNode, buildTreeIndexes } from "../../src/swarm/state/tree"
import type { TreeQuery } from "../../src/swarm/state/tree"
import { seedPopulation } from "../../src/swarm/seed"
import { emptyViewState } from "../../src/swarm/state/types"

function simpleConfig(): SwarmConfig.Info {
  return {
    enabled: true,
    max_agents: 10000,
    max_active_agents: 8,
    max_active_coding_workspaces: 4,
    max_depth: 12,
    max_children_per_agent: 500,
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
      mission_plan: "allow",
      integration: "ask",
      budget_increase: "ask",
    },
    budget: { default: { max_model_calls: 500 }, soft_ratio: 0.8 },
  }
}

function simpleRuntime(): SwarmRuntime {
  let clock = 0
  const now = () => 1_700_000_000_000 + clock++
  return new SwarmRuntime({
    config: simpleConfig(),
    provider: SwarmProvider.echoProvider(),
    workspace: SwarmWorkspace.fakeBackend(),
    now,
  })
}

test("snapshot projects agents, counts and tree indexes", async () => {
  const runtime = simpleRuntime()
  const primary = SwarmAgent.ID.create()
  const mission = runtime.createMission({ title: "t", brief: "b", primaryAgentID: primary })
  runtime.registerPrimary({ missionID: mission.id, agentID: primary })
  const a = runtime.spawn(primary, { missionID: mission.id, role: "investigator" })
  expect(a.type).toBe("spawned")
  if (a.type !== "spawned") throw new Error("expected spawn to succeed")
  const child = runtime.spawn(a.agents[0], { missionID: mission.id, role: "coder" })
  expect(child.type).toBe("spawned")
  await runtime.runToFixedPoint(10)

  const snapshot = buildSnapshot(runtime)
  expect(snapshot.agents.length).toBeGreaterThanOrEqual(3)
  const tree = buildTreeIndexes(snapshot.agents)
  expect(tree.roots.length).toBe(1)
  const primaryIndex = snapshot.agentsByID.get(primary)!
  expect(tree.descendantCounts.get(primaryIndex)!).toBe(snapshot.agents.length - 1)
  expect(snapshot.counts.completed + snapshot.counts.running).toBeGreaterThan(0)
})

test("collapsed hierarchy only renders roots until expanded", async () => {
  const runtime = simpleRuntime()
  const primary = SwarmAgent.ID.create()
  const mission = runtime.createMission({ title: "t", brief: "b", primaryAgentID: primary })
  runtime.registerPrimary({ missionID: mission.id, agentID: primary })
  seedPopulation(runtime, mission.id, primary, 2000)
  const snapshot = buildSnapshot(runtime)
  expect(snapshot.agents.length).toBe(2001)

  const query = { ...emptyViewState(), page: 0, pageSize: 40 }
  const collapsed = visibleTree(snapshot, query)
  // Only the primary root is visible (nothing expanded).
  expect(collapsed.nodes.length).toBe(1)
  expect(collapsed.total).toBe(1)
  expect(collapsed.nodes[0]!.id).toBe(primary)

  const expandedQuery = { ...query, expanded: new Set([primary]), pageSize: 200 }
  const expanded = visibleTree(snapshot, expandedQuery)
  // Primary + its direct children (50) — grandchildren hidden behind counts.
  expect(expanded.nodes.length).toBe(51)
  expect(expanded.nodes[0]!.descendantCount).toBe(2000)
})

test("filtering uses indexes and paginates a large population", async () => {
  const runtime = simpleRuntime()
  const primary = SwarmAgent.ID.create()
  const mission = runtime.createMission({ title: "t", brief: "b", primaryAgentID: primary })
  runtime.registerPrimary({ missionID: mission.id, agentID: primary })
  seedPopulation(runtime, mission.id, primary, 5000)
  const snapshot = buildSnapshot(runtime)

  const query: TreeQuery = { ...emptyViewState(), page: 0, pageSize: 25, stateFilter: "queued" }
  const result = visibleTree(snapshot, query)
  expect(result.filtered).toBe(true)
  expect(result.nodes.length).toBeLessThanOrEqual(25)
  expect(result.total).toBe(snapshot.counts.queued)
  expect(result.nodes.every((n) => n.state === "queued")).toBe(true)
})

test("expansion path opens ancestors for jump-to-agent", async () => {
  const runtime = simpleRuntime()
  const primary = SwarmAgent.ID.create()
  const mission = runtime.createMission({ title: "t", brief: "b", primaryAgentID: primary })
  runtime.registerPrimary({ missionID: mission.id, agentID: primary })
  seedPopulation(runtime, mission.id, primary, 500)
  const snapshot = buildSnapshot(runtime)
  const target = snapshot.agents.at(-1)!.id
  const path = expansionPath(snapshot, target)
  expect(path.length).toBeGreaterThan(0)
  expect(path[0]).toBe(primary)
  const query = { ...emptyViewState(), expanded: new Set(path), page: 0, pageSize: 40 }
  const page = pageForNode(snapshot, query, target)
  const jumped = visibleTree(snapshot, { ...query, page })
  expect(jumped.nodes.some((n) => n.id === target)).toBe(true)
})

test("10k snapshot + tree builds quickly", async () => {
  const runtime = simpleRuntime()
  const primary = SwarmAgent.ID.create()
  const mission = runtime.createMission({ title: "t", brief: "b", primaryAgentID: primary })
  runtime.registerPrimary({ missionID: mission.id, agentID: primary })
  seedPopulation(runtime, mission.id, primary, 10000)
  const started = performance.now()
  const snapshot = buildSnapshot(runtime)
  const buildMs = performance.now() - started

  const treeStart = performance.now()
  const query = { ...emptyViewState(), page: 0, pageSize: 40 }
  const result = visibleTree(snapshot, query)
  const treeMs = performance.now() - treeStart

  expect(snapshot.agents.length).toBe(10001)
  expect(result.nodes.length).toBeLessThanOrEqual(40)
  // Budget: well under 500ms for the full snapshot + first tree render.
  expect(buildMs + treeMs).toBeLessThan(500)
})
