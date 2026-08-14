import { expect, test } from "bun:test"
import { buildSnapshotFromServer } from "../../src/swarm/state/snapshot"
import { ServerSwarmBridge } from "../../src/swarm/server-bridge"

// ---------------------------------------------------------------------------
// TUI parser/bridge regression tests. The canonical server contract is a
// DIRECT status object (no { data: ... } wrapper) with zero counts valid.
// This pins the shape agreed in test/server/swarm-contract.test.ts.
// ---------------------------------------------------------------------------

const zeroStatus = {
  enabled: true,
  models: { allowed: ["test/test-model"], approved: 1 },
  modelStates: [{ id: "test/test-model", provider: "test", available: true, authorized: true }],
  population: { current: 0, max: 10000 },
  active: { agents: 0, max: 32, llm: 0, peak: 0 },
  workspaces: { active: 0, max: 16 },
  agentsByState: { queued: 0, completed: 0, failed: 0, awaiting_approval: 0 },
  agentsTotal: 0,
  errors: [],
}

test("zero counts are valid swarm state (not treated as missing)", () => {
  const snap = buildSnapshotFromServer(zeroStatus, { agents: [] }, Date.now())
  expect(snap.metrics.population).toBe(0)
  expect(snap.metrics.active).toBe(0)
  expect(snap.metrics.queued).toBe(0)
  expect(snap.counts.queued).toBe(0)
  expect(snap.counts.completed).toBe(0)
  expect(snap.counts.failed).toBe(0)
})

test("models render from modelStates with availability", () => {
  const snap = buildSnapshotFromServer(
    {
      ...zeroStatus,
      modelStates: [
        { id: "test/test-model", provider: "test", available: true, authorized: true },
        { id: "openai/gpt-5", provider: "openai", available: false, authorized: false },
      ],
      models: { allowed: ["test/test-model", "openai/gpt-5"], approved: 1 },
    },
    { agents: [] },
    Date.now(),
  )
  expect(snap.models.length).toBe(2)
  const available = snap.models.find((m) => m.model === "test/test-model")
  const unavailable = snap.models.find((m) => m.model === "openai/gpt-5")
  expect(available?.authorized).toBe(true)
  expect(available?.health).toBe("ok")
  expect(unavailable?.health).toBe("unavailable")
  expect(unavailable?.disabled).toBe(true)
})

test("empty allowlist still yields a valid snapshot", () => {
  const snap = buildSnapshotFromServer(
    { ...zeroStatus, enabled: false, models: { allowed: [], approved: 0 }, modelStates: [] },
    { agents: [] },
    Date.now(),
  )
  expect(snap.models.length).toBe(0)
  expect(snap.metrics.population).toBe(0)
})

test("ServerSwarmBridge parses the DIRECT (non-wrapped) status response", async () => {
  // The server returns the status object directly (see swarm-contract.test.ts).
  const statusBody = JSON.stringify(zeroStatus)
  const agentsBody = JSON.stringify({ agents: [] })
  let calls = 0
  const bridge = new ServerSwarmBridge({
    fetch: (async (url: RequestInfo | URL) => {
      calls += 1
      const u = String(url)
      if (u.includes("/swarm/status")) return new Response(statusBody, { status: 200 })
      if (u.includes("/swarm/agents")) return new Response(agentsBody, { status: 200 })
      return new Response("{}", { status: 404 })
    }) as unknown as typeof fetch,
    url: "http://opencode.internal",
    directory: "/project",
  })
  await bridge.tick()
  expect(calls).toBe(2)
  expect(bridge.error()).toBeUndefined()
  const snap = bridge.snapshot()
  expect(snap.metrics.population).toBe(0)
  expect(snap.models.length).toBe(1)
})

test("ServerSwarmBridge also tolerates a { data: ... } wrapped response (SDK transports)", async () => {
  const bridge = new ServerSwarmBridge({
    fetch: (async (url: RequestInfo | URL) => {
      const u = String(url)
      if (u.includes("/swarm/status")) return new Response(JSON.stringify({ data: zeroStatus }), { status: 200 })
      if (u.includes("/swarm/agents")) return new Response(JSON.stringify({ data: { agents: [] } }), { status: 200 })
      return new Response("{}", { status: 404 })
    }) as unknown as typeof fetch,
    url: "http://opencode.internal",
    directory: "/project",
  })
  await bridge.tick()
  expect(bridge.error()).toBeUndefined()
  expect(bridge.snapshot().metrics.population).toBe(0)
})

test("ServerSwarmBridge reports missing fields precisely, never 'missing data'", async () => {
  const bridge = new ServerSwarmBridge({
    fetch: (async () => new Response(JSON.stringify({ enabled: true }), { status: 200 })) as unknown as typeof fetch,
    url: "http://opencode.internal",
    directory: "/project",
  })
  await bridge.tick()
  expect(bridge.error()).toMatch(/swarm status: missing field population/)
})
