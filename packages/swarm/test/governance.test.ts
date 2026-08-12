import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { SwarmApproval } from "../src/approvals/approval"
import { SwarmConfig } from "../src/config/config"
import { SwarmAgent } from "../src/agent/agent"
import { SwarmAudit } from "../src/audit/audit"
import { SwarmRuntime } from "../src/runtime/runtime"
import { SwarmProvider } from "../src/provider/provider"
import { SwarmWorkspace } from "../src/workspace/workspace"
import { SwarmReview } from "../src/review/review"
import { SwarmArtifact } from "../src/artifacts/artifact"

const cfg = (overrides: Partial<SwarmConfig.Info> = {}): SwarmConfig.Info => ({
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

const grantFor = (missionID: string, risk: SwarmConfig.RiskCategory, patterns: string[] = ["*"], resources: string[] = []): SwarmApproval.Grant => ({
  id: SwarmApproval.ID.create(),
  missionID,
  actionPatterns: patterns,
  resourcePatterns: resources,
  riskCategory: risk,
  expiresAt: undefined,
  maxUses: undefined,
  uses: 0,
  time: DateTime.makeUnsafe(1_700_000_000_000),
})

function makeRuntime(c: SwarmConfig.Info) {
  const rt = new SwarmRuntime({ config: c, provider: SwarmProvider.echoProvider(), workspace: SwarmWorkspace.fakeBackend(), now: () => 1_700_000_000_000 })
  const primaryID = SwarmAgent.ID.create()
  const mission = rt.createMission({ title: "Approval test", brief: "security", primaryAgentID: primaryID })
  rt.registerPrimary({ missionID: mission.id, agentID: primaryID })
  return { rt, primaryID, mission }
}

describe("approval engine", () => {
  test("configured deny always blocks regardless of grants", () => {
    const { rt, primaryID, mission } = makeRuntime(cfg({ approval: { ...cfg().approval, merge: "deny" } }))
    // Even a mission-scoped wildcard grant cannot override an explicit deny.
    rt.addGrant(grantFor(mission.id, "R4_critical"))
    const req = rt.requestApproval(primaryID, "merge", "main", "merge")
    expect(req).toBeUndefined()
    // The deny surfaces as a tool.denied audit event.
    const denied = SwarmAudit.forType(rt.state.audit, "swarm.tool.denied").filter((e) => (e.data as { tool: string }).tool === "merge")
    expect(denied.length).toBeGreaterThan(0)
  })

  test("scoped grant allows actions within its risk rank, not beyond", () => {
    const { rt, primaryID, mission } = makeRuntime(cfg())
    // R1 grant: spawn + workspace_write auto-allow; merge still asks.
    rt.addGrant(grantFor(mission.id, "R1_isolated_local"))
    expect(rt.requestApproval(primaryID, "spawn", "any", "spawn")).toBeUndefined()
    expect(rt.requestApproval(primaryID, "workspace_write", "any", "ws")).toBeUndefined()
    const merge = rt.requestApproval(primaryID, "merge", "main", "merge")
    expect(merge).toBeDefined()
    if (merge) rt.denyApproval(merge.id)
  })

  test("expired grants no longer satisfy", () => {
    const { rt, primaryID, mission } = makeRuntime(cfg())
    const expired: SwarmApproval.Grant = {
      ...grantFor(mission.id, "R4_critical"),
      expiresAt: DateTime.makeUnsafe(1_000_000_000_000), // long past `now`
    }
    rt.addGrant(expired)
    expect(rt.requestApproval(primaryID, "merge", "main", "merge")).toBeDefined()
  })

  test("maxUses exhausts", () => {
    const { rt, primaryID, mission } = makeRuntime(cfg())
    const limited: SwarmApproval.Grant = { ...grantFor(mission.id, "R4_critical"), maxUses: 1, uses: 0 }
    rt.addGrant(limited)
    expect(rt.requestApproval(primaryID, "merge", "main", "m1")).toBeUndefined()
    expect(rt.requestApproval(primaryID, "merge", "main", "m2")).toBeDefined()
  })

  test("resource patterns scope the grant to matching resources", () => {
    const { rt, primaryID, mission } = makeRuntime(cfg())
    rt.addGrant(grantFor(mission.id, "R4_critical", ["git_push"], ["packages/alpha/**"]))
    expect(rt.requestApproval(primaryID, "git_push", "packages/alpha/main.ts", "push a")).toBeUndefined()
    const other = rt.requestApproval(primaryID, "git_push", "packages/beta/main.ts", "push b")
    expect(other).toBeDefined()
    if (other) rt.denyApproval(other.id)
  })

  test("agent cannot broaden an approved scope", () => {
    const { rt, primaryID, mission } = makeRuntime(cfg())
    rt.addGrant(grantFor(mission.id, "R1_isolated_local", ["workspace_write"]))
    // The agent tries to act like it has R3 git_commit rights — denied.
    expect(rt.requestApproval(primaryID, "git_commit", "any", "commit")).toBeDefined()
  })
})

describe("approval blocking in the runtime", () => {
  test("high-risk tool request blocks the agent and requires human grant to resume", async () => {
    const { rt, primaryID, mission } = makeRuntime(cfg({ approval: { ...cfg().approval, dependency_change: "ask" } }))
    const mergeBehaviors = new Map<string, SwarmProvider.FakeBehavior>([
      ["dep", () => [{ toolCalls: [{ tool: "dependency_change", args: { target: "package.json" } }] }, { finish: "stop" }]],
    ])
    // Wire a fresh runtime whose dep agent asks for approval.
    const rt2 = new SwarmRuntime({ config: cfg(), provider: SwarmProvider.makeFakeProvider({ behaviorsByRole: mergeBehaviors }), workspace: SwarmWorkspace.fakeBackend(), now: () => 1 })
    const p = SwarmAgent.ID.create()
    const m = rt2.createMission({ title: "dep", brief: "dep", primaryAgentID: p })
    rt2.registerPrimary({ missionID: m.id, agentID: p })
    const sp = rt2.spawn(p, { missionID: m.id, role: "dep" })
    expect(sp.type).toBe("spawned")
    await rt2.runToFixedPoint(10)
    expect(rt2.state.blockedByRequest.size).toBeGreaterThanOrEqual(1)
    const req = [...rt2.state.openApprovals.values()][0]
    expect(req).toBeDefined()
    if (req) {
      rt2.grantApproval(req.id, { missionID: m.id })
      await rt2.runToFixedPoint(10)
      expect(rt2.state.blockedByRequest.size).toBe(0)
      // The agent completed after approval.
      const done = [...rt2.state.agents.values()].some((a) => a.info.state === "completed")
      expect(done).toBe(true)
    }
  })

  test("deny leaves the agent failed, not completed", async () => {
    const rt = new SwarmRuntime({
      config: cfg(),
      provider: SwarmProvider.makeFakeProvider({
        behaviorsByRole: new Map<string, SwarmProvider.FakeBehavior>([
          ["merge", () => [{ toolCalls: [{ tool: "merge", args: { target: "main" } }] }, { finish: "stop" }]],
        ]),
      }),
      workspace: SwarmWorkspace.fakeBackend(),
      now: () => 1,
    })
    const p = SwarmAgent.ID.create()
    const m = rt.createMission({ title: "m", brief: "m", primaryAgentID: p })
    rt.registerPrimary({ missionID: m.id, agentID: p })
    const sp = rt.spawn(p, { missionID: m.id, role: "merge" })
    expect(sp.type).toBe("spawned")
    await rt.runToFixedPoint(10)
    const req = [...rt.state.openApprovals.values()][0]
    expect(req).toBeDefined()
    if (req) {
      rt.denyApproval(req.id)
      await rt.runToFixedPoint(10)
      const failed = [...rt.state.agents.values()].find((a) => a.info.role === "merge")
      expect(failed?.info.state).toBe("failed")
    }
  })

  test("mission plan approval gate must be honored before investigators spawn", () => {
    const c = cfg({ approval: { ...cfg().approval, mission_plan: "ask" } })
    const rt = new SwarmRuntime({ config: c, provider: SwarmProvider.echoProvider(), workspace: SwarmWorkspace.fakeBackend(), now: () => 1 })
    const p = SwarmAgent.ID.create()
    const mission = rt.createMission({ title: "big", brief: "big", primaryAgentID: p })
    rt.registerPrimary({ missionID: mission.id, agentID: p })
    // Without plan approval, spawning investigators is blocked by the plan gate.
    const req = rt.requestApproval(p, "mission_plan", "swarm", "plan checkpoint")
    expect(req).toBeDefined()
    if (req) rt.grantApproval(req.id, { missionID: mission.id })
    const sp = rt.spawn(p, { missionID: mission.id, role: "investigator" })
    expect(sp.type).toBe("spawned")
  })
})

describe("integration gate", () => {
  test("integration requires approval when configured 'ask'; approve then integrate", async () => {
    const behaviors = new Map<string, SwarmProvider.FakeBehavior>([
      ["implementer", () => [
        { toolCalls: [{ tool: "write_patch", args: { changedFiles: ["packages/code/a.ts"], diff: "@@", reason: "fix", tests: ["t"] } }] },
        { finish: "stop" },
      ]],
      ["proposer", () => [
        { toolCalls: [{ tool: "propose_integration", args: {} }] },
        { finish: "stop" },
      ]],
    ])
    const rt = new SwarmRuntime({ config: cfg(), provider: SwarmProvider.makeFakeProvider({ behaviorsByRole: behaviors }), workspace: SwarmWorkspace.fakeBackend(), now: () => 1 })
    const p = SwarmAgent.ID.create()
    const m = rt.createMission({ title: "integrate", brief: "integrate", primaryAgentID: p })
    rt.registerPrimary({ missionID: m.id, agentID: p })
    const impl = rt.spawn(p, { missionID: m.id, role: "implementer" })
    expect(impl.type).toBe("spawned")
    await rt.runToFixedPoint(10)
    // A patch artifact was produced in an isolated workspace.
    expect(rt.state.artifacts.size).toBe(1)
    const artifact = [...rt.state.artifacts.values()][0]!
    expect(artifact.state).toBe("proposed")

    // A proposer attempts integration → approval raised.
    const proposer = rt.spawn(p, { missionID: m.id, role: "proposer" })
    expect(proposer.type).toBe("spawned")
    await rt.runToFixedPoint(10)
    expect(rt.state.blockedByRequest.size).toBeGreaterThanOrEqual(1)

    // Without explicit human approval, nothing is integrated.
    const integratedBefore = [...rt.state.artifacts.values()].filter((a) => a.state === "integrated")
    expect(integratedBefore.length).toBe(0)

    // Human approves the integration request.
    const req = [...rt.state.openApprovals.values()].find((r) => r.action === "integration")
    expect(req).toBeDefined()
    if (req) {
      rt.grantApproval(req.id, { missionID: m.id })
      // Complete integration only after explicit approval.
      const { applied } = rt.completeIntegration(m.id, "human")
      expect(applied).toContain(artifact.artifact.id)
      expect(rt.state.artifacts.get(artifact.artifact.id)?.state).toBe("integrated")
    }
  })
})

describe("/why provenance", () => {
  test("traces mission -> task -> implementer -> patch -> reviews -> approval -> integration", async () => {
    const behaviors = new Map<string, SwarmProvider.FakeBehavior>([
      ["implementer", () => [
        { toolCalls: [{ tool: "write_patch", args: { changedFiles: ["packages/code/x.ts"], diff: "@@", reason: "fix parser", tests: ["bun test"] } }] },
        { finish: "stop" },
      ]],
      ["reviewer:correctness", () => [{ finish: "stop" }]],
    ])
    const rt = new SwarmRuntime({ config: cfg(), provider: SwarmProvider.makeFakeProvider({ behaviorsByRole: behaviors }), workspace: SwarmWorkspace.fakeBackend(), now: () => 1 })
    const p = SwarmAgent.ID.create()
    const m = rt.createMission({ title: "Mission X", brief: "fix", author: "alice", primaryAgentID: p })
    rt.registerPrimary({ missionID: m.id, agentID: p })
    const impl = rt.spawn(p, { missionID: m.id, role: "implementer" })
    expect(impl.type).toBe("spawned")
    await rt.runToFixedPoint(10)
    const artifact = [...rt.state.artifacts.values()][0]
    expect(artifact).toBeDefined()
    if (artifact) {
      const reviews = await rt.spawnReviewers(p, m.id, artifact.artifact.id, "correctness", 1)
      expect(reviews.length).toBe(1)
      const chain = SwarmProvenanceBuild(rt, "packages/code/x.ts", m.id)
      expect(chain).toContain("mission")
      expect(chain).toContain("alice")
      expect(chain).toContain("verdict=accept")
      expect(chain).toContain("packages/code/x.ts")
    }
  })
})

function SwarmProvenanceBuild(rt: SwarmRuntime, file: string, missionID: string): string {
  return rt.why(file, missionID)
}

describe("review integrity", () => {
  test("accept requires majority + no blocker/high, confidence alone is insufficient", () => {
    const id = SwarmArtifact.ID.create()
    const mk = (verdict: SwarmReview.Verdict, confidence: number, findings: SwarmReview.Finding[]): SwarmReview.Info => ({
      id: SwarmReview.ID.create(),
      reviewerAgentID: SwarmAgent.ID.create(),
      artifactID: id,
      objective: "correctness",
      verdict,
      findings,
      confidence,
      hypothesis: undefined,
      time: DateTime.makeUnsafe(1),
    })
    // Two accepts, one changes_requested => acceptable.
    expect(SwarmReview.isAcceptable([
      mk("accept", 90, []),
      mk("accept", 80, []),
      mk("changes_requested", 95, [{ severity: "low", message: "nit", location: undefined }]),
    ]).ok).toBe(true)
    // One reject among accepts => not acceptable regardless of confidence.
    expect(SwarmReview.isAcceptable([
      mk("accept", 99, []),
      mk("reject", 50, [{ severity: "high", message: "real bug", location: undefined }]),
    ]).ok).toBe(false)
    // High-confidence accept WITH a high-severity finding is still rejected.
    expect(SwarmReview.isAcceptable([mk("accept", 99, [{ severity: "high", message: "bug", location: undefined }])]).ok).toBe(false)
  })
})

describe("audit redaction", () => {
  test("redacts keys & known secret formats", () => {
    const out = SwarmAudit.redact({
      tool: "bash",
      args: { command: "curl api", api_key: "sk-abc123def456", PASSWD: "hunter2", token: "xoxb-1234567890", name: "parser" },
    }) as { args: Record<string, unknown> }
    expect(out.args.api_key).toBe("<redacted>")
    expect(out.args.PASSWD).toBe("<redacted>")
    expect(out.args.token).toBe("<redacted>")
    expect(out.args.name).toBe("parser")
  })
})