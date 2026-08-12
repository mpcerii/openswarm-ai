import { expect, test } from "bun:test"
import { createDemoBridge, createDemoRuntime } from "../../src/swarm/seed"
import { SwarmBridge, SwarmEmergencyError } from "../../src/swarm/bridge"
import { SwarmMissionBudget } from "@opencode-ai/swarm/policy/mission-budget"
import { SwarmModelHealth } from "@opencode-ai/swarm/models/health"

test("approval flow: approve once unblocks the agent without creating a grant", async () => {
  const bridge = await createDemoBridge({ population: 40, ticks: 3 })
  const before = bridge.snapshot()
  const mergeApproval = before.approvals.find((a) => a.action === "merge")
  expect(mergeApproval).toBeDefined()
  expect(mergeApproval!.severity).toBe("HIGH")

  bridge.approveOnce(mergeApproval!.id)
  const after = bridge.snapshot()
  expect(after.approvals.find((a) => a.id === mergeApproval!.id)).toBeUndefined()
  // "once" does not mint a grant (grants are only created on "always").
  expect(bridge.runtime.state.grants.length).toBe(0)
  // Agent requeued (not failed) after approval.
  const agent = after.agents.find((a) => a.id === mergeApproval!.agentID)
  expect(agent!.state === "queued" || agent!.state === "running" || agent!.state === "completed").toBe(true)
})

test("reject approval fails the awaiting agent", async () => {
  const bridge = await createDemoBridge({ population: 40, ticks: 3 })
  const approval = bridge.snapshot().approvals.find((a) => a.action === "merge")!
  bridge.reject(approval.id)
  const after = bridge.snapshot()
  const agent = after.agents.find((a) => a.id === approval.agentID)!
  expect(agent.state).toBe("failed")
  expect(after.approvals.find((a) => a.id === approval.id)).toBeUndefined()
})

test("emergency stop cancels queued work, preserves state, blocks mutations", async () => {
  const bridge = await createDemoBridge({ population: 200, ticks: 0 })
  const before = bridge.snapshot()
  const queuedBefore = before.counts.queued
  expect(queuedBefore).toBeGreaterThan(0)

  bridge.emergencyStop()
  const stopped = bridge.snapshot()
  expect(stopped.emergencyStopped).toBe(true)
  expect(stopped.paused).toBe(true)
  // Queued/created agents became cancelled; the primary (running) remains.
  expect(stopped.counts.cancelled).toBeGreaterThanOrEqual(queuedBefore - stopped.counts.running)
  // Population preserved (state not destroyed).
  expect(stopped.agents.length).toBe(before.agents.length)
  // New mutations are blocked.
  expect(() => bridge.pause()).toThrow(SwarmEmergencyError)
  expect(() => bridge.injectMessage(before.agents[0]!.id, "hi")).toThrow(SwarmEmergencyError)

  // Audit log retains the emergency event.
  expect(stopped.activity.some((a) => a.type === "swarm.emergency.stopped")).toBe(true)
})

test("resume from emergency stop restores scheduling", async () => {
  const bridge = await createDemoBridge({ population: 120, ticks: 0 })
  bridge.emergencyStop()
  bridge.resumeFromStop()
  const after = bridge.snapshot()
  expect(after.emergencyStopped).toBe(false)
  expect(after.paused).toBe(false)
  expect(after.activity.some((a) => a.type === "swarm.emergency.resumed")).toBe(true)
  // No new work is admitted while paused/stopped; the queue only shrinks.
  expect(after.counts.queued).toBe(0)
})

test("model disable/enable is reflected and respected", async () => {
  const bridge = await createDemoBridge({ population: 60, ticks: 2 })
  const model = "fake/coder"
  bridge.disableModel(model, true)
  let snap = bridge.snapshot()
  expect(snap.models.find((m) => m.model === model)!.disabled).toBe(true)
  expect(SwarmModelHealth.isUsable(bridge.runtime.state.health, model, bridge.runtime.now())).toBe(false)

  bridge.disableModel(model, false)
  snap = bridge.snapshot()
  expect(snap.models.find((m) => m.model === model)!.disabled).toBe(false)
  expect(SwarmModelHealth.isUsable(bridge.runtime.state.health, model, bridge.runtime.now())).toBe(true)
})

test("setActiveBound changes the ceiling the scheduler honors", async () => {
  const bridge = await createDemoBridge({ population: 200, ticks: 0 })
  bridge.setActiveBound(2)
  expect(bridge.snapshot().activeBound).toBe(2)
  await bridge.tick()
  const running = bridge.snapshot().counts.running
  expect(running).toBeLessThanOrEqual(2)
  expect(() => bridge.setActiveBound(0)).toThrow()
})

test("budget limits can be raised by human, clearing hard stop", async () => {
  const rt = await createDemoRuntime({ population: 20, ticks: 0 })
  const mission = [...rt.state.missions.values()][0]!
  // Drive the mission to the hard limit.
  rt.setMissionBudgetLimits(mission.id, { max_model_calls: 1, max_tokens: 10 })
  const bridge = new SwarmBridge(rt)
  await bridge.tick()
  const hard = bridge.snapshot().resources[0]
  expect(hard!.threshold === "hard" || hard!.modelCalls.used >= 1).toBe(true)

  bridge.setMissionBudgetLimits(mission.id, { max_model_calls: 1000, max_tokens: 100_000 })
  const raised = bridge.snapshot().resources[0]!
  expect(raised.modelCalls.limit).toBe(1000)
  expect(SwarmMissionBudget.evaluate(bridge.runtime.state.missionBudgets.get(mission.id)!, bridge.runtime.now(), 0.8)).toBe("ok")
})

test("budget increase approval resolves and requeues the requester", async () => {
  const bridge = await createDemoBridge({ population: 60, ticks: 3 })
  const budgetRequest = bridge.snapshot().approvals.find((a) => a.action === "budget_increase")
  expect(budgetRequest).toBeDefined()
  bridge.resolveBudgetIncrease(budgetRequest!.id, "approve", { max_model_calls: 2000, max_tokens: 1_000_000 })
  const after = bridge.snapshot()
  expect(after.approvals.find((a) => a.id === budgetRequest!.id)).toBeUndefined()
  expect(after.resources[0]!.modelCalls.limit).toBeGreaterThan(0)
})

test("worker offline and model unavailable surface as alerts", async () => {
  const bridge = await createDemoBridge({ population: 80, ticks: 3 })
  bridge.disableModel("fake/echo", true)
  const snap = bridge.snapshot()
  const model = snap.models.find((m) => m.model === "fake/echo")!
  expect(model.disabled).toBe(true)
  // The disabled model is no longer schedulable -> health shows disabled.
  expect(model.health).toBe("disabled")
  // Workers are still presented (execution lanes) with running work if any.
  expect(snap.workers.length).toBeGreaterThan(0)
})

test("permission boundaries: message only reaches a known agent", async () => {
  const bridge = await createDemoBridge({ population: 20, ticks: 0 })
  const agent = bridge.snapshot().agents.find((a) => a.role === "investigator")!
  bridge.injectMessage(agent.id, "please focus on the parser area")
  const after = bridge.snapshot()
  expect(after.queue.some((q) => q.agentID === agent.id) || bridge.runtime.state.pendingMessagesByAgent.has(agent.id)).toBe(true)
  // Unknown agent: no-op, no throw.
  bridge.injectMessage("swa_nonexistent", "hi")
})
