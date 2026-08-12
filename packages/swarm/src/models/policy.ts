export * as SwarmModels from "./policy"

import { Schema } from "effect"
import { SwarmConfig } from "../config/config"

export interface ModelPolicy extends Schema.Schema.Type<typeof ModelPolicy> {}
export const ModelPolicy = Schema.Struct({
  // Exact "provider/model" identifiers swarm agents may use.
  // EMPTY means swarm agents may use NO models (fail-closed); it never
  // falls back to granting all configured models.
  allowed: Schema.Array(Schema.String),
}).annotate({ identifier: "SwarmModels.ModelPolicy" })

export type Resolution =
  | { ok: true; model: string }
  | { ok: false; code: "no_models_allowed" | "model_not_allowed" }

export function isAllowed(policy: ModelPolicy, model: string) {
  return policy.allowed.includes(model)
}

// Model requested by an agent (or via LLM-provided tool arguments) is never
// trusted: resolution fails unless the exact identifier is in the allowlist.
// Without a request, the first allowed model is the deterministic default.
export function resolve(policy: ModelPolicy, requested?: string): Resolution {
  if (policy.allowed.length === 0) return { ok: false, code: "no_models_allowed" }
  if (requested === undefined) return { ok: true, model: policy.allowed[0] }
  if (isAllowed(policy, requested)) return { ok: true, model: requested }
  return { ok: false, code: "model_not_allowed" }
}

// Build the runtime model policy from human configuration. The allowlist is
// the ONLY source of truth — an empty `swarm.models.allowed` yields a policy
// that admits NO models (fail-closed), never falling back to the instance's
// configured providers.
export function fromConfig(config: SwarmConfig.Info): ModelPolicy {
  return { allowed: config.models.allowed }
}

// Per-model usage accounting. The runtime tracks active and population counts
// per model; admission must respect SwarmConfig.ModelLimits when present.
export interface ModelUsage {
  readonly active: number
  readonly population: number
  readonly tokens: number
}

export function emptyUsage(): ModelUsage {
  return { active: 0, population: 0, tokens: 0 }
}

export function canAdmitModel(limits: SwarmConfig.ModelLimits | undefined, usage: ModelUsage): boolean {
  if (limits === undefined) return true
  if (limits.concurrency !== undefined && usage.active >= limits.concurrency) return false
  if (limits.population !== undefined && usage.population >= limits.population) return false
  return true
}

// Token budget is soft: exceeding it surfaces an approval request, never a
// hard stop, so a partially completed agent is not silently killed.
export function tokenBudgetExceeded(budget: number | undefined, usage: ModelUsage): boolean {
  if (budget === undefined) return false
  return usage.tokens > budget
}

// Convenience: resolve the configured limits for a specific model id.
export function limitsFor(config: SwarmConfig.ModelsConfig, model: string): SwarmConfig.ModelLimits | undefined {
  return config.limits ? config.limits[model] : undefined
}