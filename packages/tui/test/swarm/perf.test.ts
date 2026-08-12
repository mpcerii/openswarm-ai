import { expect, test } from "bun:test"
import { SwarmRuntime } from "@opencode-ai/swarm/runtime/runtime"
import { SwarmAgent } from "@opencode-ai/swarm/agent/agent"
import { SwarmWorkspace } from "@opencode-ai/swarm/workspace/workspace"
import { SwarmProvider } from "@opencode-ai/swarm/provider/provider"
import { SwarmConfig } from "@opencode-ai/swarm/config/config"
import { buildSnapshot } from "../../src/swarm/state/snapshot"
import { visibleTree, pageForNode, expansionPath } from "../../src/swarm/state/tree"
import { seedPopulation } from "../../src/swarm/seed"
import { emptyViewState } from "../../src/swarm/state/types"

// ---------------------------------------------------------------------------
// Large-population performance: snapshot building, first tree page, and
// jump-to-agent must stay interactive at 10k agents / ~100k audit events.
// Measurements are logged for the report; the assertion is a generous ceiling
// so slow regressions fail loudly without being flaky.
// ---------------------------------------------------------------------------

function perfConfig(): SwarmConfig.Info {
  return {
    enabled: true,
    max_agents: 100000,
    max_active_agents: 64,
    max_active_coding_workspaces: 16,
    max_depth: 12,
    max_children_per_agent: 500,
    models: {
      allowed: ["fake/echo"],
      limits: undefined,
      providers: undefined,
      pools: undefined,
      catalog: undefined,
      routing: { policy: "balanced" as const },
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
    budget: { default: undefined, soft_ratio: 0.8 },
  }
}

test("10k agents: snapshot + tree render + jump stay interactive", () => {
  let clock = 0
  const runtime = new SwarmRuntime({
    config: perfConfig(),
    provider: SwarmProvider.echoProvider(),
    workspace: SwarmWorkspace.fakeBackend(),
    now: () => 1_700_000_000_000 + clock++,
  })
  const primary = SwarmAgent.ID.create()
  const mission = runtime.createMission({ title: "perf", brief: "b", primaryAgentID: primary })
  runtime.registerPrimary({ missionID: mission.id, agentID: primary })
  seedPopulation(runtime, mission.id, primary, 10000)

  const buildStart = performance.now()
  const snapshot = buildSnapshot(runtime)
  const snapshotMs = performance.now() - buildStart

  const treeStart = performance.now()
  const query = { ...emptyViewState(), page: 0, pageSize: 40 }
  const firstPage = visibleTree(snapshot, query)
  const treeMs = performance.now() - treeStart

  const jumpStart = performance.now()
  const target = snapshot.agents.at(-1)!.id
  const path = expansionPath(snapshot, target)
  const expanded = new Set(path)
  const page = pageForNode(snapshot, { ...query, expanded }, target)
  const jumped = visibleTree(snapshot, { ...query, expanded, page })
  const jumpMs = performance.now() - jumpStart

  expect(snapshot.agents.length).toBe(10001)
  expect(firstPage.nodes.length).toBeLessThanOrEqual(40)
  expect(page).toBeGreaterThan(0)
  expect(jumped.nodes.some((n) => n.id === target)).toBe(true)
  // Interactive budget: ~200ms is comfortable; the tree paths are usually < 1ms.
  expect(snapshotMs).toBeLessThan(200)
  expect(treeMs).toBeLessThan(200)
  expect(jumpMs).toBeLessThan(200)
  console.log(
    `[swarm-perf] agents=${snapshot.agents.length} audit=${snapshot.metrics.auditEvents} snapshot=${snapshotMs.toFixed(1)}ms tree_page=${treeMs.toFixed(1)}ms jump=${jumpMs.toFixed(1)}ms`,
  )
})

test("filtering 10k agents by state uses indexes and paginates", () => {
  let clock = 0
  const runtime = new SwarmRuntime({
    config: perfConfig(),
    provider: SwarmProvider.echoProvider(),
    workspace: SwarmWorkspace.fakeBackend(),
    now: () => 1_700_000_000_000 + clock++,
  })
  const primary = SwarmAgent.ID.create()
  const mission = runtime.createMission({ title: "perf", brief: "b", primaryAgentID: primary })
  runtime.registerPrimary({ missionID: mission.id, agentID: primary })
  seedPopulation(runtime, mission.id, primary, 10000)
  const snapshot = buildSnapshot(runtime)

  const start = performance.now()
  const result = visibleTree(snapshot, { ...emptyViewState(), stateFilter: "queued", page: 0, pageSize: 25 })
  const ms = performance.now() - start
  expect(result.filtered).toBe(true)
  expect(result.total).toBe(snapshot.counts.queued)
  expect(result.nodes.every((n) => n.state === "queued")).toBe(true)
  expect(ms).toBeLessThan(200)
  console.log(`[swarm-perf] filter queued(${result.total}) page=${result.nodes.length} ${ms.toFixed(1)}ms`)
})
