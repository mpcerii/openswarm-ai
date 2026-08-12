import { expect, test } from "bun:test"
import { createDemoBridge } from "../../src/swarm/seed"
import { integrationReview } from "../../src/swarm/state/approvals"

// ---------------------------------------------------------------------------
// End-to-end data flow the overlay views consume: the demo seed must produce a
// snapshot rich enough for every tab (overview counts, tree, approvals,
// artifacts, reviews, activity, models, workers, resources, /why).
// ---------------------------------------------------------------------------

test("demo bridge produces a full operational snapshot for every view", async () => {
  const bridge = await createDemoBridge({ population: 240, ticks: 3 })
  const s = bridge.snapshot()

  // Overview — every agent lands in exactly one raw state bucket. (`blocked`
  // and `done` are derived aggregates, not raw states.)
  expect(s.missions.length).toBe(1)
  const c = s.counts
  const summed = c.created + c.queued + c.running + c.waiting + c.sleeping + c.awaitingApproval + c.completed + c.failed + c.cancelled + c.retired
  expect(summed).toBe(s.agents.length)
  expect(c.blocked).toBe(c.awaitingApproval + c.waiting)
  expect(c.done).toBe(c.completed + c.failed + c.cancelled + c.retired)
  expect(s.primarySummary.lines.length).toBeGreaterThan(0)

  // Tree — roots are agent indexes; descendantCounts is keyed by index.
  expect(s.roots.length).toBe(1)
  const primaryIndex = s.roots[0]!
  expect(s.descendantCounts.get(primaryIndex)).toBe(s.agents.length - 1)

  // Approvals: at least a merge (HIGH) or budget increase is pending.
  expect(s.approvals.length).toBeGreaterThan(0)
  expect(s.approvals.some((a) => a.severity === "HIGH" || a.severity === "MEDIUM")).toBe(true)

  // Artifacts + reviews (implementers wrote patches, reviewers reviewed).
  expect(s.artifacts.length).toBeGreaterThan(0)
  expect(s.artifacts.some((a) => a.reviews.length > 0)).toBe(true)

  // Activity feed is curated (never raw internal model chatter).
  expect(s.activity.length).toBeGreaterThan(0)
  expect(s.activity.every((a) => !a.type.startsWith("swarm.tool."))).toBe(true)

  // Models + workers + resources.
  expect(s.models.length).toBeGreaterThan(0)
  expect(s.workers.length).toBeGreaterThan(0)
  expect(s.resources.length).toBe(1)

  // Integration review over the mission artifacts is computable.
  const review = integrationReview(s.artifacts, { id: s.missions[0]!.id, title: s.missions[0]!.title }, s.now)
  expect(review.patchCount).toBeGreaterThan(0)
  expect(review.filesChanged).toBeGreaterThan(0)

  // /why chain renders for a changed file.
  const why = bridge.runtime.why("packages/code/main.ts", s.missions[0]!.id)
  expect(why).toContain("mission")
})

test("human actions through the overlay surface update the snapshot immediately", async () => {
  const bridge = await createDemoBridge({ population: 120, ticks: 3 })
  const approval = bridge.snapshot().approvals[0]!
  const before = bridge.snapshot()

  bridge.approveOnce(approval.id)
  const after = bridge.snapshot()
  expect(after.approvals.find((a) => a.id === approval.id)).toBeUndefined()
  expect(after.agents.length).toBe(before.agents.length)

  bridge.disableModel("fake/echo", true)
  expect(bridge.snapshot().models.find((m) => m.model === "fake/echo")!.disabled).toBe(true)
})
