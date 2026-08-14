export * as SwarmWorkspace from "./workspace"

import { Schema } from "effect"
import { AbsolutePath, optional, statics } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"

export const Kind = Schema.Literals(["in_place", "worktree"]).annotate({
  identifier: "SwarmWorkspace.Kind",
})
export type Kind = typeof Kind.Type

export const State = Schema.Literals(["pending", "allocated", "released"]).annotate({
  identifier: "SwarmWorkspace.State",
})
export type State = typeof State.Type

// Workspaces are allocated lazily to executing agents only; logical
// population never owns per-agent worktrees. A 10k-agent simulation runs
// with `maxActiveCodingWorkspaces` (~16) — never 1:1 with population.
export interface Allocation extends Schema.Schema.Type<typeof Allocation> {}
export const Allocation = Schema.Struct({
  agentID: SwarmAgent.ID,
  kind: Kind,
  state: State,
  path: optional(AbsolutePath),
  branch: optional(Schema.String),
}).annotate({ identifier: "SwarmWorkspace.Allocation" })

// Backend seam — the real implementation calls openSwarm's `Worktree` service
// (shadow repos under Global.Path.data/worktree). The swarm package only
// depends on schema+effect, so the kernel offers this injectable interface;
// tests use an in-memory backend.
export interface Backend {
  allocate(agentID: SwarmAgent.ID, branch: string): Promise<Allocation>
  release(agentID: SwarmAgent.ID): Promise<void>
  list(): ReadonlyArray<Allocation>
}

// In-memory fake: useful for tests + simulation. Never touches the real
// filesystem — perfect for the 10k-agent test.
export function fakeBackend(): Backend & { allocations: Allocation[] } {
  const allocations: Allocation[] = []
  return {
    allocations,
    async allocate(agentID, branch) {
      const alloc: Allocation = {
        agentID,
        kind: "worktree",
        state: "allocated",
        path: `fake://worktree/${agentID}/${branch}` as unknown as AbsolutePath,
        branch,
      }
      allocations.push(alloc)
      return alloc
    },
    async release(agentID) {
      const idx = allocations.findIndex((a) => a.agentID === agentID)
      if (idx >= 0) {
        const a = allocations[idx]!
        allocations[idx] = { ...a, state: "released" }
      }
    },
    list() {
      return allocations.filter((a) => a.state === "allocated")
    },
  }
}

// Manager bound to a workspace backend + a bounded budget from
// SwarmBudget.Accounts. `tryAcquire` is the only way to consume a workspace
// slot; release refunds it. The kernel decides *whether* an agent needs a
// coding workspace — read-only reviewers never allocate one.
export interface Manager {
  readonly backend: Backend
  readonly maxActive: number
  // Live allocations keyed by agentID. Pure-ish: only mutated by acquire/release.
  readonly byAgent: Map<string, Allocation>
  // Back-reference into SwarmBudget.Accounts so workspace accounting is atomic
  // against the global budget.
  setActiveWorkspaceCount(n: number): void
}

export function managerFor(backend: Backend, maxActive: number): Manager {
  return {
    backend,
    maxActive,
    byAgent: new Map(),
    setActiveWorkspaceCount(_n: number) {
      void _n
    },
  }
}

export type AcquireResult =
  | { ok: true; allocation: Allocation }
  | { ok: false; reason: "max_active_reached"; capacity: number }

export async function acquireWorkspace(m: Manager, agentID: SwarmAgent.ID, branch: string, currentActive: number): Promise<AcquireResult> {
  if (currentActive >= m.maxActive) {
    return { ok: false, reason: "max_active_reached", capacity: m.maxActive }
  }
  const existing = m.byAgent.get(agentID)
  if (existing) return { ok: true, allocation: existing }
  const allocation = await m.backend.allocate(agentID, branch)
  m.byAgent.set(agentID, allocation)
  m.setActiveWorkspaceCount(currentActive + 1)
  return { ok: true, allocation }
}

export async function releaseWorkspace(m: Manager, agentID: SwarmAgent.ID, currentActive: number): Promise<number> {
  const existing = m.byAgent.get(agentID)
  if (existing) {
    m.byAgent.delete(agentID)
    await m.backend.release(agentID)
    m.setActiveWorkspaceCount(Math.max(0, currentActive - 1))
    return Math.max(0, currentActive - 1)
  }
  return currentActive
}