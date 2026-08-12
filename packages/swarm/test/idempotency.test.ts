import { describe, expect, test } from "bun:test"
import { SwarmIdempotency } from "../src/cluster/idempotency"
import { MemoryStore } from "../src/storage/memory"
import { SqliteStore } from "../src/storage/sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DurableStore } from "../src/storage/store"

const limits = { max_agents: 100, max_active_agents: 4, max_depth: 3, max_children_per_agent: 10 }

function makeStore(): DurableStore {
  const dir = mkdtempSync(join(tmpdir(), "swarm-op-"))
  return new SqliteStore(join(dir, "db"), limits, 8, 2)
}

function op(kind: SwarmIdempotency.Kind, key: string): SwarmIdempotency.Record {
  return { id: SwarmIdempotency.ID.create(), kind, op_key: key, result: null, claimed_by: null, created_at: 1, completed_at: null }
}

describe("idempotency ledger", () => {
  for (const store of [new MemoryStore(limits, 8, 2), makeStore()] as DurableStore[]) {
    test("a completed operation is replayed, not re-executed", async () => {
      const first = op("agent.run", "agent:swa_1:3")
      const began = await store.beginOperation(first)
      expect(began.duplicate).toBe(false)
      await store.completeOperation(first.id, { state: "completed", artifacts: ["swf_1"] }, 2)

      // The retry uses the SAME key (same run number) -> duplicate replay.
      const retry = op("agent.run", "agent:swa_1:3")
      const replay = await store.beginOperation(retry)
      expect(replay.duplicate).toBe(true)
      if (replay.duplicate) expect(replay.result).toEqual({ state: "completed", artifacts: ["swf_1"] })
    })

    test("a fresh run number re-executes even after a prior crash", async () => {
      const first = op("agent.run", "agent:swa_1:3")
      await store.beginOperation(first)
      // Crash before completion: the op is registered but never completed.
      const retry = op("agent.run", "agent:swa_1:4")
      const began = await store.beginOperation(retry)
      expect(began.duplicate).toBe(false)
    })

    test("different keys are distinct; hasOperation reflects registration", async () => {
      const a = op("artifact.create", "artifact:swa_9:deadbeef")
      await store.beginOperation(a)
      expect(await store.hasOperation("artifact.create", "artifact:swa_9:deadbeef")).toBe(true)
      expect(await store.hasOperation("artifact.create", "artifact:swa_9:other")).toBe(false)
    })

    test("composite keys are stable and unique per run", () => {
      expect(SwarmIdempotency.agentRunKey("swa_1", 1)).toBe("agent:swa_1:1")
      expect(SwarmIdempotency.agentRunKey("swa_1", 2)).toBe("agent:swa_1:2")
      expect(SwarmIdempotency.agentRunKey("swa_1", 1)).not.toBe(SwarmIdempotency.agentRunKey("swa_2", 1))
    })
  }
})
