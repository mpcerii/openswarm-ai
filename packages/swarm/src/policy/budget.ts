export * as SwarmBudget from "./budget"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, DateTimeUtcFromMillis } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"

export interface Limits extends Schema.Schema.Type<typeof Limits> {}
export const Limits = Schema.Struct({
  max_agents: PositiveInt,
  max_active_agents: PositiveInt,
  max_depth: NonNegativeInt,
  max_children_per_agent: NonNegativeInt,
}).annotate({ identifier: "SwarmBudget.Limits" })

// Per-agent capacity receipt recorded when a spawn atomically consumes
// global budget. Children can never mint capacity: only the swarm runtime
// creates receipts.
export interface AgentBudget extends Schema.Schema.Type<typeof AgentBudget> {}
export const AgentBudget = Schema.Struct({
  agentID: SwarmAgent.ID,
  depth: NonNegativeInt,
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "SwarmBudget.AgentBudget" })

export interface SpawnUsage {
  readonly population: number
  readonly parentDepth?: number
  readonly parentChildren?: number
}

export type SpawnRejection = "population_exceeded" | "depth_exceeded" | "children_exceeded"
export type SpawnEvaluation = { ok: true; depth: number } | { ok: false; code: SpawnRejection }

// Depth of the primary/root agent is 0; a spawned child sits one deeper.
export function evaluateSpawn(limits: Limits, usage: SpawnUsage, count = 1): SpawnEvaluation {
  if (usage.population + count > limits.max_agents) return { ok: false, code: "population_exceeded" }
  const depth = (usage.parentDepth ?? 0) + 1
  if (depth > limits.max_depth) return { ok: false, code: "depth_exceeded" }
  if ((usage.parentChildren ?? 0) + count > limits.max_children_per_agent)
    return { ok: false, code: "children_exceeded" }
  return { ok: true, depth }
}

export function canAdmit(limits: Limits, activeAgents: number) {
  return activeAgents < limits.max_active_agents
}

// ---------------------------------------------------------------------------
// Runtime accounting state — pure & in-memory. The runtime owns a single
// Accounts object; mutations here are the ONLY place capacity is consumed or
// reclaimed, so accounting stays atomic against concurrency.
// ---------------------------------------------------------------------------

export interface Accounts {
  // Total non-retired logical agents ever spawned (decremented only when an
  // agent explicitly retires/prunes from the ledger).
  population: number
  // Currently executing agents (one session drain per agent).
  active: number
  // High-water mark of `active` ever observed. Instrumented by setActive so
  // the scheduler's concurrency bound is provable from accounting alone.
  activePeak: number
  // Children ever spawned per parent. Used by evaluateSpawn.
  childrenByParent: Map<string, number>
  // Coding workspaces currently allocated to executing agents.
  activeWorkspaces: number
  // High-water mark of activeWorkspaces.
  workspacePeak: number
}

export function emptyAccounts(): Accounts {
  return { population: 0, active: 0, activePeak: 0, childrenByParent: new Map(), activeWorkspaces: 0, workspacePeak: 0 }
}

export interface Consumption {
  readonly population: number
  readonly active: number
}

// Try to consume one spawn slot (population + parent-children). Active-slot
// consumption is separate: a queued agent stays accounted against population
// but does not consume an active slot until admitted by the scheduler.
export function tryConsumeSpawn(
  limits: Limits,
  accounts: Accounts,
  parent: { id: string; depth: number } | undefined,
): { ok: true; depth: number } | { ok: false; code: SpawnRejection } {
  const parentChildren = parent ? (accounts.childrenByParent.get(parent.id) ?? 0) : 0
  const evalResult = evaluateSpawn(limits, {
    population: accounts.population,
    parentDepth: parent?.depth,
    parentChildren,
  })
  if (!evalResult.ok) return evalResult
  accounts.population += 1
  if (parent) accounts.childrenByParent.set(parent.id, parentChildren + 1)
  return evalResult
}

// Reclaim population accounting when an agent is cancelled or retired. We do
// NOT raise the active counter here; that is reclaimed by setActive(false).
export function releasePopulation(accounts: Accounts) {
  if (accounts.population > 0) accounts.population -= 1
}

// Full release: decrement the population slot AND the parent's children-per-
// agent counter so a cancelled child frees the parent's future spawn budget
// too. Pure accounting; the runtime calls this exactly once per release.
export function releaseSpawn(accounts: Accounts, parentID?: string) {
  if (accounts.population > 0) accounts.population -= 1
  if (parentID !== undefined) {
    const children = accounts.childrenByParent.get(parentID) ?? 0
    if (children > 0) accounts.childrenByParent.set(parentID, children - 1)
  }
}

// Mark an agent as starting or stopping execution; toggles the active counter
// only when transitioning between states. Returns the new active count.
export function setActive(accounts: Accounts, entering: boolean): number {
  if (entering) {
    accounts.active += 1
    if (accounts.active > accounts.activePeak) accounts.activePeak = accounts.active
  } else if (accounts.active > 0) {
    accounts.active -= 1
  }
  return accounts.active
}

export function tryConsumeWorkspace(accounts: Accounts, max: number): boolean {
  if (accounts.activeWorkspaces >= max) return false
  accounts.activeWorkspaces += 1
  if (accounts.activeWorkspaces > accounts.workspacePeak) accounts.workspacePeak = accounts.activeWorkspaces
  return true
}

export function releaseWorkspace(accounts: Accounts) {
  if (accounts.activeWorkspaces > 0) accounts.activeWorkspaces -= 1
}