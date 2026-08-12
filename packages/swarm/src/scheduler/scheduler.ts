export * as SwarmScheduler from "./scheduler"

import { Schema } from "effect"
import { optional } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"
import { SwarmBudget } from "../policy/budget"

export const Decision = Schema.Literals(["admit", "queue"]).annotate({
  identifier: "SwarmScheduler.Decision",
})
export type Decision = typeof Decision.Type

export interface Admission extends Schema.Schema.Type<typeof Admission> {}
export const Admission = Schema.Struct({
  agentID: SwarmAgent.ID,
  decision: Decision,
  reason: optional(Schema.String),
}).annotate({ identifier: "SwarmScheduler.Admission" })

export interface AdmissionInput {
  readonly limits: SwarmBudget.Limits
  readonly accounts: SwarmBudget.Accounts
  readonly waiting: ReadonlyArray<SwarmAgent.ID>
}

// Decide admission for a single agent. The decision is pure given the
// accounts snapshot: the runtime calls admit() within the same tick that it
// mutates Accounts so the bound stays atomic across the population.
export function admit(input: AdmissionInput, candidate: SwarmAgent.ID): Admission {
  if (!SwarmBudget.canAdmit(input.limits, input.accounts.active)) {
    return { agentID: candidate, decision: "queue", reason: "max_active_agents reached" }
  }
  return { agentID: candidate, decision: "admit" }
}

// ---------------------------------------------------------------------------
// Wait queue. The runtime keeps a single FIFO of pending (queued) agent IDs
// plus a wakeup reason. Re-scanning the queue on every state transition keeps
// scheduling O(n) over the *waiting* set, which stays small because active
// bound keeps the running set small and the scheduler drains the queue as
// slots free up.
// ---------------------------------------------------------------------------

export interface Queue {
  readonly items: Array<{ agentID: SwarmAgent.ID; queuedAt: number; reason: string }>
}

export function emptyQueue(): Queue {
  return { items: [] }
}

export function enqueue(q: Queue, agentID: SwarmAgent.ID, reason: string, now: number): void {
  if (!q.items.some((i) => i.agentID === agentID)) q.items.push({ agentID, queuedAt: now, reason })
}

export function dequeue(q: Queue): { agentID: SwarmAgent.ID; queuedAt: number; reason: string } | undefined {
  return q.items.shift()
}

export function remove(q: Queue, agentID: SwarmAgent.ID): void {
  const idx = q.items.findIndex((i) => i.agentID === agentID)
  if (idx >= 0) q.items.splice(idx, 1)
}

export function queueSize(q: Queue): number {
  return q.items.length
}

// Fair admission scan: returns the next agent that can be admitted under the
// current accounts budget, given a population predicate (the runtime supplies
// a `stillQueued(id)` check to handle agents that might be cancelled while
// waiting). Mutates accounts only when admitted.
export function drainOne(
  input: AdmissionInput,
  q: Queue,
  stillQueued: (id: SwarmAgent.ID) => boolean,
): { admitted: SwarmAgent.ID } | { idle: true } {
  while (true) {
    const next = dequeue(q)
    if (next === undefined) return { idle: true }
    if (!stillQueued(next.agentID)) continue
    const decision = admit(input, next.agentID)
    if (decision.decision === "admit") {
      SwarmBudget.setActive(input.accounts, true)
      return { admitted: next.agentID }
    }
    // put back at the front so priority is preserved across ticks.
    q.items.unshift(next)
    return { idle: true }
  }
}

// Batch admission: admit up to `budget` queued agents in one scan, consuming
// active slots atomically so the runtime can run the whole batch concurrently.
// Respects the active bound AND the per-agent stillQueued predicate. An
// optional `defer` predicate keeps an agent queued without admitting it (rate
// limit backoff, mission hard budget, unusable model health) by rotating it to
// the back of the queue — never dropped, never admitted.
// Returns the admitted ids; the caller is responsible for running them.
export function drainBatch(
  input: AdmissionInput,
  q: Queue,
  stillQueued: (id: SwarmAgent.ID) => boolean,
  budget: number,
  defer?: (id: SwarmAgent.ID) => boolean,
): SwarmAgent.ID[] {
  const admitted: SwarmAgent.ID[] = []
  let scanned = 0
  while (admitted.length < budget && scanned <= q.items.length) {
    const next = dequeue(q)
    if (next === undefined) break
    scanned++
    if (!stillQueued(next.agentID)) continue
    if (defer !== undefined && defer(next.agentID)) {
      q.items.push(next)
      continue
    }
    const decision = admit(input, next.agentID)
    if (decision.decision !== "admit") {
      q.items.unshift(next)
      break
    }
    SwarmBudget.setActive(input.accounts, true)
    admitted.push(next.agentID)
  }
  return admitted
}

// ---------------------------------------------------------------------------
// Pause / Resume. The runtime exposes a `paused` flag; the scheduler honors
// it so the human can halt execution without losing the queue. Cancelled
// branch is removed alongside its child agents by the runtime, and the
// scheduler's `stillQueued` predicate reflects that.
// ---------------------------------------------------------------------------

export interface PauseState {
  paused: boolean
}

export function emptyPauseState(): PauseState {
  return { paused: false }
}