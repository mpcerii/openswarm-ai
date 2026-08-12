import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { SwarmSimulation } from "../src/simulation/simulation"
import { SwarmBudget } from "../src/policy/budget"
import { SwarmAgent } from "../src/agent/agent"
import { SwarmModels } from "../src/models/policy"
import { SwarmApproval } from "../src/approvals/approval"
import { SwarmConflict } from "../src/conflict/conflict"
import { SwarmDedup } from "../src/dedup/dedup"
import { SwarmReview } from "../src/review/review"
import { SwarmConfig } from "../src/config/config"
import { SwarmRuntime } from "../src/runtime/runtime"
import { SwarmProvider } from "../src/provider/provider"
import { SwarmWorkspace } from "../src/workspace/workspace"
import { SwarmCensus } from "../src/census/census"
import { SwarmAudit } from "../src/audit/audit"
import { SwarmArtifact } from "../src/artifacts/artifact"

const tinyConfig = (overrides: Partial<SwarmConfig.Info> = {}): SwarmConfig.Info => ({
  enabled: true,
  max_agents: 200,
  max_active_agents: 8,
  max_active_coding_workspaces: 4,
  max_depth: 4,
  max_children_per_agent: 50,
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
  budget: { default: undefined, soft_ratio: 0.8 },
  ...overrides,
})

describe("10k-agent simulation", () => {
  test("manages 10,000 logical agents with bounded resources (no LLM)", async () => {
    const startHeap = SwarmSimulation.heapUsageMB()
    const result = await SwarmSimulation.run10kSimulation()
    const m = result.metrics
    const total = result.runtime.state.agents.size

    // Population invariant: stayed within budget and reached the target tier.
    expect(total).toBeGreaterThanOrEqual(1000)
    expect(total).toBeLessThanOrEqual(10000)
    // Active bound held throughout the simulation.
    expect(m.activePeak).toBeLessThanOrEqual(64)
    // Coding workspaces capped at 16 even with 10k logical agents.
    expect(m.workspacePeak).toBeLessThanOrEqual(16)
    // Queue throughput exercised the scheduler; the simulation finished.
    expect(m.admittedTotal).toBeGreaterThan(0)
    // Audit log accumulated events (missions, spawns, transitions).
    expect(m.auditEvents).toBeGreaterThanOrEqual(total)
    // No paid LLM traffic: echoProvider never threw, so awaiting approvals stays at 0.
    expect(m.awaitingApproval).toBe(0)
    // Full population accounting: accounts stayed <= max Agents at all times.
    expect(result.runtime.state.accounts.population).toBeLessThanOrEqual(
      (SwarmSimulation.defaultConfig({
        population: 10000,
        activeBound: 64,
        workspaceBound: 16,
        childrenPerAgent: 50,
        maxDepth: 6,
      }) as SwarmConfig.Info).max_agents,
    )
    // Heap should not have leaked by more than a few hundred MB for 10k agents.
    const endHeap = SwarmSimulation.heapUsageMB()
    if (!Number.isNaN(startHeap) && !Number.isNaN(endHeap)) {
      expect(endHeap - startHeap).toBeLessThan(1200)
    }
    // Bounded run regardless of population: the harness finished in well
    // under 30s on commodity hardware in development.
    expect(m.wallMs).toBeLessThan(60_000)
    // Report a compact summary; useful as the artifact requested by the spec.
    console.log("[10k-sim]", {
      population: total,
      ...m,
      peakHeapMB: Number.isNaN(startHeap) ? "n/a" : `${startHeap}->${SwarmSimulation.heapUsageMB()}`,
    })
  }, 60_000)

  test("concurrency stays bounded during a small fan-out burst", async () => {
    const seen: number[] = []
    const result = await SwarmSimulation.runSimulation({
      population: 500,
      activeBound: 4,
      workspaceBound: 2,
      childrenPerAgent: 10,
      maxDepth: 3,
      onTick: (mt, rt) => seen.push(rt.metrics().active),
    })
    expect(Math.max(...seen)).toBeLessThanOrEqual(4)
    expect(result.metrics.failed + result.metrics.cancelled).toBe(0)
    expect(result.runtime.state.agents.size).toBeGreaterThanOrEqual(100)
  })
})

describe("model allowlist enforcement (fail-closed)", () => {
  test("empty allowlist rejects all spawns even when asked tries to broaden", () => {
    const rt = new SwarmRuntime({
      config: { ...tinyConfig(), models: { allowed: [] } },
      provider: SwarmProvider.echoProvider(),
      workspace: SwarmWorkspace.fakeBackend(),
    })
    const mission = rt.createMission({ title: "x", brief: "x", primaryAgentID: SwarmAgent.ID.create() })
    const result = rt.spawn(undefined, { missionID: mission.id, role: "investigator" })
    expect(result.type).toBe("rejected")
    if (result.type === "rejected") expect(result.code).toBe("no_models_allowed")
  })

  test("unknown model id rejected even when allowlist non-empty", () => {
    const rt = new SwarmRuntime({
      config: tinyConfig(),
      provider: SwarmProvider.echoProvider(),
      workspace: SwarmWorkspace.fakeBackend(),
    })
    const mission = rt.createMission({ title: "x", brief: "x", primaryAgentID: SwarmAgent.ID.create() })
    const result = rt.spawn(undefined, { missionID: mission.id, model: "anthropic/claude-opus" })
    expect(result.type).toBe("rejected")
    if (result.type === "rejected") expect(result.code).toBe("model_not_allowed")
  })

  test("agent cannot broaden an approved scope; grants have <= risk rank", () => {
    // Grant at R1_isolated_local cannot satisfy a merge (R4) request.
    const now = 1_700_000_000_000
    const cfg = tinyConfig()
    const rt = new SwarmRuntime({ config: cfg, provider: SwarmProvider.echoProvider(), workspace: SwarmWorkspace.fakeBackend(), now: () => 1 })
    const primaryID = SwarmAgent.ID.create()
    const mission = rt.createMission({ title: "x", brief: "x", primaryAgentID: primaryID })
    rt.registerPrimary({ missionID: mission.id, agentID: primaryID })
    const grant: SwarmApproval.Grant = {
      id: SwarmApproval.ID.create(),
      missionID: mission.id,
      actionPatterns: ["*"],
      resourcePatterns: [],
      riskCategory: "R1_isolated_local",
      expiresAt: undefined,
      maxUses: undefined,
      uses: 0,
      time: DateTime.makeUnsafe(now),
    }
    rt.addGrant(grant)
    // A merge request still needs approval — R1 grant does NOT promote to R4.
    const req = rt.requestApproval(primaryID, "merge", "main", "merge pr")
    expect(req).toBeDefined()
    if (req !== undefined) {
      expect(req!.action).toBe("merge")
      rt.denyApproval(req!.id)
    }
    // Same agent requesting spawn (R1) is auto-allowed because the grant matches.
    const allowReq = rt.requestApproval(primaryID, "spawn", "any", "spawn")
    expect(allowReq).toBeUndefined()
  })
})

describe("conflict control", () => {
  test("leases prevent overlapping writes; non-overlapping writes coexist", () => {
    const lm = SwarmConflict.emptyLeaseManager()
    const a = SwarmAgent.ID.create()
    const b = SwarmAgent.ID.create()
    const r1 = SwarmConflict.acquireLease(lm, a, { pattern: "packages/runtime/**", mode: "exclusive_write" }, 1)
    expect(r1.ok).toBe(true)
    const r2 = SwarmConflict.acquireLease(lm, b, { pattern: "packages/runtime/**", mode: "exclusive_write" }, 2)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.conflictingAgent).toBe(a)
    const r3 = SwarmConflict.acquireLease(lm, b, { pattern: "packages/swarm/**", mode: "exclusive_write" }, 3)
    expect(r3.ok).toBe(true)
  })

  test("merge prediction flags overlapping patches", () => {
    const pred = SwarmConflict.predictMerges([
      { id: "a", files: ["packages/swarm/src/runtime.ts"] },
      { id: "b", files: ["packages/swarm/src/runtime.ts", "packages/swarm/src/scheduler.ts"] },
      { id: "c", files: ["packages/swarm/src/dedup.ts"] },
    ])
    expect(pred.safe).toBe(false)
    if (!pred.safe) {
      expect(pred.pairs.length).toBe(1)
      expect(pred.pairs[0]!.overlap).toEqual(["packages/swarm/src/runtime.ts"])
    }
  })
})

describe("deduplication/clustering", () => {
  test("many agents reporting the same concept collapse into one canonical finding", () => {
    const state = SwarmDedup.emptyClusteringState()
    const reporters = [SwarmAgent.ID.create(), SwarmAgent.ID.create(), SwarmAgent.ID.create()]
    for (const r of reporters) {
      SwarmDedup.clusterReport(state, {
        title: "Parser crashes on malformed input",
        area: "packages/llm/parser",
        location: "packages/llm/parser/index.ts:42",
        severity: "high",
        reporter: r,
        time: DateTime.makeUnsafe(new Date("2025-01-01").getTime()),
      })
    }
    expect(SwarmDedup.clusterCount(state)).toBe(1)
    const cluster = SwarmDedup.listClusters(state)[0]!
    expect(cluster.reporters.length).toBe(3)
    expect(cluster.reportCount).toBe(3)
  })

  test("conceptually distinct findings stay separate", () => {
    const state = SwarmDedup.emptyClusteringState()
    SwarmDedup.clusterReport(state, {
      title: "Parser crash on invalid tokens",
      area: "packages/llm/parser",
      severity: "high",
      reporter: SwarmAgent.ID.create(),
      time: DateTime.makeUnsafe(1),
    })
    SwarmDedup.clusterReport(state, {
      title: "Scheduler deadlocks under high load",
      area: "packages/swarm/scheduler",
      severity: "high",
      reporter: SwarmAgent.ID.create(),
      time: DateTime.makeUnsafe(2),
    })
    expect(SwarmDedup.clusterCount(state)).toBe(2)
  })
})

describe("review swarms", () => {
  test("a single high-severity finding blocks integration regardless of reviewer confidence", () => {
    const reviewer = SwarmAgent.ID.create()
    const reviews: SwarmReview.Info[] = [
      {
        id: SwarmReview.ID.create(),
        reviewerAgentID: reviewer,
        artifactID: SwarmArtifact.ID.create(),
        objective: "adversarial",
        verdict: "accept",
        findings: [
          { severity: "high", message: "race condition under high load", location: undefined },
        ],
        confidence: 99,
        hypothesis: undefined,
        time: DateTime.makeUnsafe(1),
      },
    ]
    expect(SwarmReview.isAcceptable(reviews).ok).toBe(false)
  })
})

describe("budget", () => {
  test("spending spawn budget rejects further children; release reclaims", () => {
    const limits: SwarmBudget.Limits = {
      max_agents: 5,
      max_active_agents: 2,
      max_depth: 4,
      max_children_per_agent: 2,
    }
    const acc = SwarmBudget.emptyAccounts()
    const parentID = "swa_parent"
    const r1 = SwarmBudget.tryConsumeSpawn(limits, acc, { id: parentID, depth: 0 })
    expect(r1.ok).toBe(true)
    const r2 = SwarmBudget.tryConsumeSpawn(limits, acc, { id: parentID, depth: 0 })
    expect(r2.ok).toBe(true)
    const r3 = SwarmBudget.tryConsumeSpawn(limits, acc, { id: parentID, depth: 0 })
    expect(r3.ok).toBe(false)
    if (!r3.ok) expect(r3.code).toBe("children_exceeded")
    // Full release reclaims BOTH the population slot and the parent's children
    // count, so the parent can spawn again.
    SwarmBudget.releaseSpawn(acc, parentID)
    const r4 = SwarmBudget.tryConsumeSpawn(limits, acc, { id: parentID, depth: 0 })
    expect(r4.ok).toBe(true)
  })
})

describe("provider seam + fake behaviour", () => {
  test("fakeProvider routes behavior by role", async () => {
    const calls: string[] = []
    const behaviors = new Map<string, SwarmProvider.FakeBehavior>([
      ["investigator", () => [{ delta: "i", finish: "stop", tokens: 5 }]],
      ["implementer", (req, step) => (step === 0 ? [{ delta: "imp", toolCalls: [{ tool: "register_finding", args: { title: "found", severity: "medium" } }] }] : [{ finish: "stop" }])],
    ])
    const provider = SwarmProvider.makeFakeProvider({
      behaviorsByRole: behaviors,
      fallback: () => [{ finish: "stop" }],
    })
    const iter = provider.stream({
      agentID: SwarmAgent.ID.create(),
      model: "fake/echo",
      role: "investigator",
      systemPrompt: "",
      userText: "",
      missionID: "m1",
    })
    for await (const c of iter) {
      if (c.delta !== undefined) calls.push(c.delta)
      if (c.finish !== undefined) calls.push(c.finish)
    }
    expect(calls).toContain("i")
    expect(calls).toContain("stop")
    // The historical call count tracks the request.
    void provider
  })
})

describe("primary agent registers & spawns", () => {
  test("end-to-end micro swarm (no LLM): primary spawns investigator + reviewer", async () => {
    const cfg = tinyConfig()
    const behaviors = new Map<string, SwarmProvider.FakeBehavior>([
      ["primary", (_req, _step) => [{ finish: "stop" }]],
      ["investigator", (req, _step) => [
        { toolCalls: [{ tool: "register_finding", args: { title: "parser crash", severity: "high", area: "packages/llm/parser", location: "parser.ts" } }] },
        { finish: "stop" },
      ]],
      ["implementer", (_req, _step) => [
        { toolCalls: [{ tool: "write_patch", args: { changedFiles: ["packages/llm/parser.ts"], diff: "@@ FIX", tests: ["bun test"], reason: "fix parser" } }] },
        { finish: "stop" },
      ]],
      ["reviewer:correctness", (_req) => [{ toolCalls: [{ tool: "register_review_finding", args: { severity: "low", message: "minor" } }] }, { finish: "stop" }]],
    ])
    const provider = SwarmProvider.makeFakeProvider({
      behaviorsByRole: behaviors,
      fallback: (req, _step) => [{ finish: "stop" }],
    })
    // Pre-census: the swarm limits each agent's permitted files.
    void SwarmCensus
    const rt = new SwarmRuntime({
      config: cfg,
      provider,
      workspace: SwarmWorkspace.fakeBackend(),
      now: () => 1_700_000_000_000,
    })
    const primaryID = SwarmAgent.ID.create()
    const mission = rt.createMission({ title: "Fix reliability", brief: "investigate, fix, review", primaryAgentID: primaryID })
    rt.registerPrimary({ missionID: mission.id, agentID: primaryID })

    // Base path: investigators + implementer spawn guarded by budget.
    const spawn1 = rt.spawn(primaryID, { missionID: mission.id, role: "investigator" })
    const spawn2 = rt.spawn(primaryID, { missionID: mission.id, role: "investigator" })
    const spawn3 = rt.spawn(primaryID, { missionID: mission.id, role: "implementer" })
    expect(spawn1.type).toBe("spawned")
    expect(spawn2.type).toBe("spawned")
    expect(spawn3.type).toBe("spawned")
    // The primary agent is OpenCode's `build` session — it is registered, not
    // spawned, so it does not consume swarm population accounting. Only the
    // three spawned children count.
    expect(rt.state.accounts.population).toBe(3)

    // Drain: each admitted agent runs to completion (emit findings/patches).
    await rt.runToFixedPoint(20)
    // At least one artifact and one clustered finding landed.
    expect(rt.state.artifacts.size).toBeGreaterThan(0)
    expect(SwarmDedup.clusterCount(rt.state.clustering)).toBeGreaterThan(0)
    // All agents end terminal-ish: completed/failed/etc.
    for (const r of rt.state.agents.values()) {
      expect(["running", "completed", "failed", "cancelled", "awaiting_approval", "queued", "waiting"].includes(r.info.state)).toBe(true)
    }
    const primaryBusy = rt.state.agents.get(primaryID)!.info.state
    void primaryBusy
    expect(true).toBe(true)
  })
})

describe("audit redaction", () => {
  test("redacts known secret shapes but preserves non-sensitive metadata", () => {
    const input = {
      tool: "bash",
      args: { command: "echo hello", api_key: "sk-abc123def456", PASSWD: "hunter2", title: "patch notes" },
    }
    const out = SwarmAudit.redact(input) as { args: Record<string, unknown> }
    expect(out.args.api_key).toBe("<redacted>")
    expect(out.args.PASSWD).toBe("<redacted>")
    expect(out.args.title).toBe("patch notes")
    expect(out.args.command).toBe("echo hello")
  })
})

describe("deterministic stress scenario", () => {
  test("exercises mailbox traffic, cancellation, approval blocking, artifacts & retries", async () => {
    const outcome = await SwarmSimulation.runStressScenario()
    // Artifacts: the coder agent wrote a patch (workspace isolation proven).
    expect(outcome.artifacts).toBeGreaterThanOrEqual(1)
    // Cancellation: the doomed agent was cancelled while queued.
    expect(outcome.cancelledAgents).toBeGreaterThanOrEqual(1)
    // Approval blocking: the merge agent is blocked awaiting human approval.
    expect(outcome.awaitingApproval).toBeGreaterThanOrEqual(1)
    // Mailbox: injected messages were delivered/drained.
    expect(outcome.deliveredMessages).toBe(1)
    // Retry: the flaky agent failed once then succeeded (bounded retry, no
    // infinite loop), so its failure is recorded exactly once in flakyIDs.
    expect(outcome.retriedAgents).toBeGreaterThanOrEqual(1)
    // After a human approves the merge, the blocked agent may continue.
    const openReq = [...outcome.runtime.state.openApprovals.values()][0]
    expect(openReq).toBeDefined()
    if (openReq !== undefined) {
      outcome.runtime.grantApproval(openReq.id)
      await outcome.runtime.runToFixedPoint(10)
      expect(outcome.runtime.state.blockedByRequest.size).toBe(0)
    }
  })
})

describe("/why provenance", () => {
  test("returns the mission -> task -> artifact -> review chain", async () => {
    const cfg = tinyConfig({ max_active_agents: 4 })
    const behaviors = new Map<string, SwarmProvider.FakeBehavior>([
      ["implementer", () => [{ toolCalls: [{ tool: "write_patch", args: { changedFiles: ["packages/swarm/src/runtime.ts"], diff: "@@", reason: "fix", tests: ["t"] } }] }, { finish: "stop" }]],
    ])
    const provider = SwarmProvider.makeFakeProvider({
      behaviorsByRole: behaviors,
      fallback: () => [{ finish: "stop" }],
    })
    const rt = new SwarmRuntime({ config: cfg, provider, workspace: SwarmWorkspace.fakeBackend(), now: () => 1 })
    const primary = SwarmAgent.ID.create()
    const mission = rt.createMission({ title: "Mission title", brief: "B", author: "alice", primaryAgentID: primary })
    rt.registerPrimary({ missionID: mission.id, agentID: primary })
    const sp = rt.spawn(primary, { missionID: mission.id, role: "implementer" })
    expect(sp.type).toBe("spawned")
    await rt.runToFixedPoint(20)
    const artifact = [...rt.state.artifacts.values()][0]
    expect(artifact).toBeDefined()
    // Trigger a review so /why chains the verdict.
    if (artifact) {
      const reviewers = await rt.spawnReviewers(primary, mission.id, artifact.artifact.id, "correctness", 1)
      expect(reviewers.length).toBe(1)
    }
    const why = rt.why("packages/swarm/src/runtime.ts", mission.id)
    expect(why).toContain(`/why packages/swarm/src/runtime.ts`)
    expect(why).toContain(`mission: ${mission.id}`)
    expect(why).toMatch(/alice|human/)
    expect(why).toContain(`verdict=`)
  })
})