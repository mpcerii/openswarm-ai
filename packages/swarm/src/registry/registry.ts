export * as SwarmRegistry from "./registry"

import { SwarmConfig } from "../config/config"
import { SwarmModelCatalog } from "../models/catalog"
import { SwarmPools } from "../models/pools"
import { SwarmModelHealth } from "../models/health"
import { SwarmGovernor } from "../policy/governor"
import { SwarmMissionBudget } from "../policy/mission-budget"

// ---------------------------------------------------------------------------
// Queryable state for the TUI "Models" and "Resource" views (Phase 3 builds
// the actual terminal UI on top of these shapes). Everything here is a pure
// projection of runtime state — no I/O, no mutation.
// ---------------------------------------------------------------------------

export interface ModelViewEntry {
  model: string
  provider: string
  authorized: boolean
  pools: string[]
  health: SwarmModelHealth.Health
  active: number
  // Concurrent calls waiting on this model's concurrency/rate limits.
  queued: number
  concurrencyLimit?: number
  contextWindow?: number
}

export interface ModelsView {
  entries: ModelViewEntry[]
}

export interface ResourceView {
  missionID: string
  population: number
  maxAgents?: number
  activeAgents: number
  activeWorkspaces: number
  llmCallsConcurrent: number
  llmCallsQueued: number
  tokenBudget: { used: number; limit?: number; ratio: number }
  modelCalls: { used: number; limit?: number; ratio: number }
  threshold: SwarmMissionBudget.Threshold
  pendingApprovals: number
}

export interface BudgetViewInput {
  readonly budget: SwarmMissionBudget.MissionBudgetState
  readonly threshold: SwarmMissionBudget.Threshold
}

// "Models" view: one row per allowed model with authorization, pool
// membership, health, and live concurrency. Queued counts come from the
// governor's pending backlog (exposed by the runtime, not the governor itself).
export function modelsView(config: SwarmConfig.Info, health: SwarmModelHealth.HealthState, governor: SwarmGovernor.GovernorState, queuedByModel?: ReadonlyMap<string, number>): ModelsView {
  const active = SwarmGovernor.activeByModel(governor)
  const entries = SwarmModelCatalog.buildCatalog(config).map((m) => {
    const healthState = SwarmModelHealth.healthOf(health, m.id)
    return {
      model: m.id,
      provider: m.provider,
      authorized: m.enabled,
      pools: SwarmPools.poolsForModel(config, m.id),
      health: healthState.health,
      active: active.get(m.id) ?? 0,
      queued: queuedByModel?.get(m.id) ?? 0,
      concurrencyLimit: config.models.limits?.[m.id]?.concurrency,
      contextWindow: m.contextWindow,
    }
  })
  return { entries }
}

export function resourceView(accounts: { population: number; active: number; activeWorkspaces: number }, llmConcurrent: number, llmQueued: number, budget: BudgetViewInput, pendingApprovals: number): ResourceView {
  const maxAgents = budget.budget.limits.max_agents
  const tokenLimit = budget.budget.limits.max_tokens
  const callLimit = budget.budget.limits.max_model_calls
  return {
    missionID: budget.budget.missionID,
    population: accounts.population,
    maxAgents,
    activeAgents: accounts.active,
    activeWorkspaces: accounts.activeWorkspaces,
    llmCallsConcurrent: llmConcurrent,
    llmCallsQueued: llmQueued,
    tokenBudget: { used: budget.budget.usage.tokens, limit: tokenLimit, ratio: tokenLimit ? budget.budget.usage.tokens / tokenLimit : 0 },
    modelCalls: { used: budget.budget.usage.modelCalls, limit: callLimit, ratio: callLimit ? budget.budget.usage.modelCalls / callLimit : 0 },
    threshold: budget.threshold,
    pendingApprovals,
  }
}
