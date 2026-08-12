export * as SwarmMissionBudget from "./mission-budget"

import { SwarmConfig } from "../config/config"

// ---------------------------------------------------------------------------
// Mission budget ledger. Pure decision helpers plus a mutable per-mission
// state used by the LOCAL runtime. The distributed control plane keeps the
// same semantics against durable atomic counters in the store, so budget
// exhaustion is enforced exactly once even across workers.
//
// Thresholds: below soft_ratio the mission is "ok"; between soft and hard it
// is "soft" (warn the primary, still schedule); at/over a hard limit it is
// "hard" (stop scheduling new expensive work, preserve state, wait for human).
// ---------------------------------------------------------------------------

export type MissionBudgetLimits = {
  readonly max_agents?: number
  readonly max_active_agents?: number
  readonly max_model_calls?: number
  readonly max_tokens?: number
  readonly max_wall_ms?: number
  readonly max_cost?: number
}

export interface MissionBudgetUsage {
  readonly modelCalls: number
  readonly tokens: number
  readonly wallMs: number
  readonly cost: number
}

export type Threshold = "ok" | "soft" | "hard"

export interface MissionBudgetState {
  readonly missionID: string
  limits: MissionBudgetLimits
  usage: MissionBudgetUsage
  readonly startedAt: number
  softWarned: boolean
  hardReached: boolean
}

export function emptyUsage(): MissionBudgetUsage {
  return { modelCalls: 0, tokens: 0, wallMs: 0, cost: 0 }
}

export function makeState(missionID: string, limits: MissionBudgetLimits, startedAt: number, usage: MissionBudgetUsage = emptyUsage()): MissionBudgetState {
  return { missionID, limits, usage, startedAt, softWarned: false, hardReached: false }
}

export function limitsFromConfig(budget: SwarmConfig.BudgetConfig | undefined, overrides: SwarmConfig.MissionBudget | undefined): MissionBudgetLimits {
  const d = budget?.default
  return {
    max_agents: overrides?.max_agents ?? d?.max_agents,
    max_active_agents: overrides?.max_active_agents ?? d?.max_active_agents,
    max_model_calls: overrides?.max_model_calls ?? d?.max_model_calls,
    max_tokens: overrides?.max_tokens ?? d?.max_tokens,
    max_wall_ms: overrides?.max_wall_ms ?? d?.max_wall_ms,
    max_cost: overrides?.max_cost ?? d?.max_cost,
  }
}

export function softRatio(config: SwarmConfig.Info): number {
  const ratio = config.budget?.soft_ratio
  if (ratio === undefined) return 0.8
  return Math.min(1, Math.max(0, ratio))
}

// The current threshold for a mission given its limits, usage and now.
export function evaluate(state: MissionBudgetState, now: number, ratio: number): Threshold {
  if (hardReached(state, now)) return "hard"
  const soft = softReached(state, now, ratio)
  return soft ? "soft" : "ok"
}

// Try to consume one model call. Returns false when the hard call limit is
// reached (or the mission is already hard). The caller must not mutate any
// task state when this returns false.
export function tryConsumeCall(state: MissionBudgetState): boolean {
  if (state.hardReached) return false
  const max = state.limits.max_model_calls
  if (max !== undefined && state.usage.modelCalls + 1 > max) return false
  state.usage = { ...state.usage, modelCalls: state.usage.modelCalls + 1 }
  return true
}

// Record tokens spent. Soft-advisory only at the state level; hard enforcement
// happens via the hardReached flag set by consume-time checks.
export function addTokens(state: MissionBudgetState, tokens: number): void {
  if (tokens <= 0) return
  state.usage = { ...state.usage, tokens: state.usage.tokens + tokens }
}

export function addCost(state: MissionBudgetState, cost: number): void {
  if (cost <= 0) return
  state.usage = { ...state.usage, cost: state.usage.cost + cost }
}

// Mark the mission hard so scheduling stops; preserves state (agents remain
// queued/sleeping, never mutated into half-finished tasks).
export function markHard(state: MissionBudgetState): void {
  state.hardReached = true
}

// Human approved an increase: raise limits so scheduling can resume.
export function increaseLimits(state: MissionBudgetState, increase: MissionBudgetLimits): void {
  const merge = (field: keyof MissionBudgetLimits): number | undefined => {
    const next = increase[field]
    if (next === undefined) return state.limits[field]
    const current = state.limits[field]
    if (current === undefined) return next
    return current + next
  }
  state.limits = {
    max_agents: merge("max_agents"),
    max_active_agents: merge("max_active_agents"),
    max_model_calls: merge("max_model_calls"),
    max_tokens: merge("max_tokens"),
    max_wall_ms: merge("max_wall_ms"),
    max_cost: merge("max_cost"),
  }
  // A raised budget may clear a previously reached hard flag.
  state.hardReached = false
}

// Set absolute limits (used by "Modify" replies).
export function setLimits(state: MissionBudgetState, limits: MissionBudgetLimits): void {
  state.limits = limits
  state.hardReached = false
}

// ---------------------------------------------------------------------------
// Threshold helpers
// ---------------------------------------------------------------------------

function hardReached(state: MissionBudgetState, now: number): boolean {
  if (state.limits.max_model_calls !== undefined && state.usage.modelCalls >= state.limits.max_model_calls) return true
  if (state.limits.max_tokens !== undefined && state.usage.tokens >= state.limits.max_tokens) return true
  if (state.limits.max_wall_ms !== undefined && now - state.startedAt >= state.limits.max_wall_ms) return true
  if (state.limits.max_cost !== undefined && state.usage.cost >= state.limits.max_cost) return true
  return false
}

function softReached(state: MissionBudgetState, now: number, ratio: number): boolean {
  if (state.limits.max_model_calls !== undefined && state.usage.modelCalls >= state.limits.max_model_calls * ratio) return true
  if (state.limits.max_tokens !== undefined && state.usage.tokens >= state.limits.max_tokens * ratio) return true
  if (state.limits.max_wall_ms !== undefined && now - state.startedAt >= state.limits.max_wall_ms * ratio) return true
  if (state.limits.max_cost !== undefined && state.usage.cost >= state.limits.max_cost * ratio) return true
  return false
}
