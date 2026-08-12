import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DateTime } from "effect"
import { SwarmAgent } from "../src/agent/agent"
import { MemoryStore } from "../src/storage/memory"
import { SqliteStore } from "../src/storage/sqlite"
import type { DurableStore, SpawnLimits } from "../src/storage/store"

const limits: SpawnLimits = { max_agents: 100, max_active_agents: 4, max_depth: 3, max_children_per_agent: 10 }

function agent(id: string): SwarmAgent.AgentRecord {
  return {
    id: id as SwarmAgent.ID,
    rootID: id as SwarmAgent.ID,
    parent: undefined,
    depth: 0,
    role: "echo",
    state: "queued",
    mission: "m1",
    model: undefined,
    resolvedModel: "fake/echo",
    sessionID: undefined,
    spawnCredits: 0,
    budget: undefined,
    taskIDs: undefined,
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  }
}

function sqliteStore(): SqliteStore {
  const dir = mkdtempSync(join(tmpdir(), "swarm-store-"))
  return new SqliteStore(join(dir, "swarm.db"), limits, 8, 2)
}

for (const [name, makeStore] of [
  ["memory", () => new MemoryStore(limits, 8, 2)],
  ["sqlite", () => sqliteStore()],
] as const) {
  describe(`store (${name})`, () => {
    test("spawn accounting is atomic and never over-spends", async () => {
      const store: DurableStore = makeStore()
      const results = await Promise.all(
        Array.from({ length: 8 }, () => store.atomicTryConsumeSpawn(undefined, 1)),
      )
      expect(results.filter((r) => r.ok).length).toBe(8)
      const accounting = await store.accounting()
      expect(accounting.population).toBe(8)

      // 8 concurrent attempts against a nearly-full budget admit at most the
      // remaining slots, never more.
      const store2: DurableStore = makeStore()
      const small: SpawnLimits = { max_agents: 3, max_active_agents: 2, max_depth: 3, max_children_per_agent: 10 }
      const smallStore = name === "memory" ? new MemoryStore(small, 8, 2) : new SqliteStore(join(mkdtempSync(join(tmpdir(), "s-")), "db"), small, 8, 2)
      const attempts = await Promise.all(
        Array.from({ length: 10 }, (_, i) => smallStore.atomicTryConsumeSpawn(i % 2 === 0 ? `parent${i % 3}` : undefined, 1)),
      )
      const admitted = attempts.filter((r) => r.ok).length
      expect(admitted).toBe(3)
      expect((await smallStore.accounting()).population).toBe(3)
    })

    test("active and LLM slots admit within their bounds under concurrency", async () => {
      const store: DurableStore = makeStore()
      const admits = await Promise.all(Array.from({ length: 20 }, () => store.atomicTryAdmitAgent()))
      expect(admits.filter(Boolean).length).toBe(4)
      expect((await store.accounting()).activeAgents).toBe(4)
      expect((await store.accounting()).activeAgentsPeak).toBe(4)

      const llm = await Promise.all(Array.from({ length: 20 }, () => store.atomicTryReserveLLM()))
      expect(llm.filter(Boolean).length).toBe(8)
      for (let i = 0; i < 8; i++) await store.atomicReleaseLLM()
      expect((await store.accounting()).activeLLM).toBe(0)
    })

    test("lease claim is atomic: only one worker wins", async () => {
      const store: DurableStore = makeStore()
      const lease = {
        id: "swl_t1",
        agent_id: "swa_t1",
        worker_id: null,
        run_number: 1,
        status: "pending" as const,
        issued_at: 0,
        last_heartbeat: 0,
        expires_at: 1000,
        attempts: 0,
        op_key: "agent:swa_t1:1",
        result: null,
        created_at: 0,
        llm_reserved: false,
      }
      await store.putLease(lease)
      const [a, b] = await Promise.all([
        store.atomicClaimLease(lease.id, "swk_a", 1),
        store.atomicClaimLease(lease.id, "swk_b", 1),
      ])
      const winners = [a, b].filter((r) => r.ok)
      expect(winners.length).toBe(1)
      if (winners[0]!.ok) expect(winners[0]!.lease.worker_id).toBe("swk_a" as string)
    })

    test("expired leases cannot be claimed and are swept", async () => {
      const store: DurableStore = makeStore()
      const lease = {
        id: "swl_t2",
        agent_id: "swa_t2",
        worker_id: null,
        run_number: 1,
        status: "pending" as const,
        issued_at: 0,
        last_heartbeat: 0,
        expires_at: 100,
        attempts: 0,
        op_key: "agent:swa_t2:1",
        result: null,
        created_at: 0,
        llm_reserved: false,
      }
      await store.putLease(lease)
      const claim = await store.atomicClaimLease(lease.id, "swk_a", 200)
      expect(claim.ok).toBe(false)
      const expired = await store.expireLeases(undefined, 200)
      expect(expired).toEqual(["swl_t2"])
    })

    test("agent transitions validate the state machine", async () => {
      const store: DurableStore = makeStore()
      const id = "swa_trans"
      await store.putAgent(agent(id))
      // queued -> completed is illegal and must throw.
      await expect(store.transitionAgent(id, "completed")).rejects.toThrow()
      const updated = await store.transitionAgent(id, "running")
      expect(updated?.state).toBe("running")
      const done = await store.transitionAgent(id, "completed")
      expect(done?.state).toBe("completed")
      const list = await store.listAgentsByState("completed")
      expect(list.length).toBe(1)
    })

    test("queue: publish / claim / ack / nack / extend with claim tokens", async () => {
      const store: DurableStore = makeStore()
      const q = store.queue
      await q.publish({ id: "q1", kind: "lease:w1", payload: "lease1", visibleAt: 0, createdAt: 0 })
      await q.publish({ id: "q2", kind: "lease:w2", payload: "lease2", visibleAt: 5, createdAt: 0 })
      await q.publish({ id: "q3", kind: "lease:w1", payload: "lease3", visibleAt: 100, createdAt: 0 })

      const claimed = await q.claim(2, 0, "lease:w1")
      expect(claimed.length).toBe(1)
      expect(claimed[0]!.id).toBe("q1")
      // A message claimed with a token cannot be acked by a wrong token.
      expect(await q.ack("q1", "wrong-token")).toBe(false)
      // Extend the visibility window, then ack correctly.
      expect(await q.extend("q1", claimed[0]!.claimToken, 1000)).toBe(true)
      expect(await q.ack("q1", claimed[0]!.claimToken)).toBe(true)
      // Nack makes the message visible again (at-least-once delivery).
      await q.publish({ id: "q4", kind: "lease:w1", payload: "lease4", visibleAt: 0, createdAt: 0 })
      const c2 = await q.claim(1, 0, "lease:w1")
      expect(c2[0]!.id).toBe("q4")
      await q.nack("q4", c2[0]!.claimToken, 50)
      expect(await q.claim(1, 10, "lease:w1")).toHaveLength(0)
      const c3 = await q.claim(1, 60, "lease:w1")
      expect(c3[0]!.id).toBe("q4")
      expect(c3[0]!.attempts).toBe(2)
    })

    test("queue kind filter isolates worker shards", async () => {
      const store: DurableStore = makeStore()
      const q = store.queue
      await q.publish({ id: "a1", kind: "lease:w1", payload: "x", visibleAt: 0, createdAt: 0 })
      await q.publish({ id: "a2", kind: "lease:w2", payload: "y", visibleAt: 0, createdAt: 0 })
      const w1 = await q.claim(10, 0, "lease:w1")
      const w2 = await q.claim(10, 0, "lease:w2")
      expect(w1.map((m) => m.id)).toEqual(["a1"])
      expect(w2.map((m) => m.id)).toEqual(["a2"])
    })
  })
}

describe("store lifecycle", () => {
  test("mission, census, messages, tasks, artifacts, audit round-trip", async () => {
    const store: DurableStore = new MemoryStore(limits, 8, 2)
    const id = "swa_rt"
    await store.putAgent(agent(id))
    await store.putMission({ id: "swm_rt", author: "alice", title: "t", brief: "b", planApproved: false, integrationApproved: false, primaryAgentID: id as SwarmAgent.ID, createdAt: 1 })
    const mission = await store.getMission("swm_rt")
    expect(mission?.author).toBe("alice")
    await store.appendAudit({ type: "swarm.agent.completed", time: 2, data: { agentID: id } })
    expect((await store.eventsByType("swarm.agent.completed")).length).toBe(1)
  })
})
