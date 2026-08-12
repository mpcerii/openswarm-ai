export * as SwarmConfig from "./config"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, optional, statics } from "@opencode-ai/schema/schema"

// Risk categories arranged from read-only to destructive. Greater index = greater
// risk. Approval scopes may approve any category up to a granted level, but never
// beyond it: agents may not broaden an approved scope.
export const RiskCategory = Schema.Literals(["R0_read", "R1_isolated_local", "R2_project_change", "R3_external", "R4_critical"]).annotate({
  identifier: "SwarmConfig.RiskCategory",
})
export type RiskCategory = typeof RiskCategory.Type

export const riskRank: Readonly<Record<RiskCategory, number>> = Object.freeze({
  R0_read: 0,
  R1_isolated_local: 1,
  R2_project_change: 2,
  R3_external: 3,
  R4_critical: 4,
})

// A configured action maps to a risk category and a default decision. The
// permission engine consults these rules plus any granted approval scopes
// (see approvals module).
export interface ActionRule extends Schema.Schema.Type<typeof ActionRule> {}
export const ActionRule = Schema.Struct({
  risk: RiskCategory,
  effect: Schema.Literals(["allow", "ask", "deny"]),
}).annotate({ identifier: "SwarmConfig.ActionRule" })

export interface ModelLimits extends Schema.Schema.Type<typeof ModelLimits> {}
export const ModelLimits = Schema.Struct({
  // Upper bound on concurrent executing agents using this model.
  concurrency: optional(PositiveInt),
  // Upper bound on total logical agents (population) that may use this model
  // across a whole mission.
  population: optional(PositiveInt),
  // Requests-per-window ceiling for this model (window_ms). Only enforced when
  // both fields are declared; the runtime does not guess provider windows.
  requests_per_window: optional(PositiveInt),
  window_ms: optional(PositiveInt),
  // Token throughput ceiling for this model per window_ms. Advisory when no
  // pricing data exists; token/call limits stay enforceable independently.
  tokens_per_window: optional(NonNegativeInt),
  // Rough relative latency hint (ms) declared by the user for
  // prefer-lowest-latency routing. Never auto-derived from the provider.
  latency_ms: optional(NonNegativeInt),
  // Rough cheapness ranking (lower = cheaper) for prefer-cheapest routing.
  priority: optional(PositiveInt),
}).annotate({ identifier: "SwarmConfig.ModelLimits" })

export const RoutingPolicy = Schema.Literals([
  "prefer-cheapest",
  "prefer-lowest-latency",
  "prefer-strongest",
  "balanced",
  "explicit-only",
]).annotate({ identifier: "SwarmConfig.RoutingPolicy" })
export type RoutingPolicy = typeof RoutingPolicy.Type

export interface ModelCatalogEntry extends Schema.Schema.Type<typeof ModelCatalogEntry> {}
export const ModelCatalogEntry = Schema.Struct({
  // Reliable metadata the user declares for an allowed model. The provider
  // abstraction supplies dynamic provider info; we never hardcode unstable
  // provider specs here.
  context_window: optional(PositiveInt),
  capabilities: optional(
    Schema.Struct({
      tools: optional(Schema.Boolean),
      vision: optional(Schema.Boolean),
      reasoning: optional(Schema.Boolean),
    }),
  ),
  priority: optional(PositiveInt),
  latency_ms: optional(NonNegativeInt),
}).annotate({ identifier: "SwarmConfig.ModelCatalogEntry" })

export interface ProviderLimits extends Schema.Schema.Type<typeof ProviderLimits> {}
export const ProviderLimits = Schema.Struct({
  // Upper bound on concurrent provider calls (across all its models).
  concurrency: optional(PositiveInt),
  requests_per_window: optional(PositiveInt),
  window_ms: optional(PositiveInt),
  tokens_per_window: optional(NonNegativeInt),
}).annotate({ identifier: "SwarmConfig.ProviderLimits" })

export interface ModelsConfig extends Schema.Schema.Type<typeof ModelsConfig> {}
export const ModelsConfig = Schema.Struct({
  allowed: Schema.Array(Schema.String),
  // Optional per-model limits keyed by "provider/model".
  limits: optional(Schema.Record(Schema.String, ModelLimits)),
  // Optional provider-level limits keyed by provider id.
  providers: optional(Schema.Record(Schema.String, ProviderLimits)),
  // Semantic pools the human defines; each maps a pool name to allowed model
  // ids. Membership is never auto-augmented: pool members outside `allowed`
  // are ignored, and a pool with no allowed members resolves empty.
  pools: optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  // Optional per-model static metadata (context window, capabilities).
  catalog: optional(Schema.Record(Schema.String, ModelCatalogEntry)),
  // Human-chosen routing policy for capability/pool-based selection.
  routing: optional(
    Schema.Struct({
      policy: RoutingPolicy,
    }),
  ),
  // Optional global concurrent LLM call cap enforced by the governor. When
  // unset the active-agent bound is the effective ceiling.
  global_concurrency: optional(PositiveInt),
  // Optional mission-wide soft token budget. Soft = advisory; the runtime
  // raises an approval when exceeded, but does not hard-stop agents.
  mission_token_budget: optional(NonNegativeInt),
}).annotate({ identifier: "SwarmConfig.ModelsConfig" })

export interface MissionBudget extends Schema.Schema.Type<typeof MissionBudget> {}
export const MissionBudget = Schema.Struct({
  max_agents: optional(PositiveInt),
  max_active_agents: optional(PositiveInt),
  max_model_calls: optional(PositiveInt),
  max_tokens: optional(PositiveInt),
  // Optional wall-clock budget for the mission (ms).
  max_wall_ms: optional(PositiveInt),
  // Advisory only: without pricing data a monetary budget is informational,
  // never a hard stop. Token/call limits remain enforceable independently.
  max_cost: optional(Schema.Number),
}).annotate({ identifier: "SwarmConfig.MissionBudget" })

export interface BudgetConfig extends Schema.Schema.Type<typeof BudgetConfig> {}
export const BudgetConfig = Schema.Struct({
  // Mission-level budget applied to every mission unless overridden at
  // creation. Absent fields are unbounded.
  default: optional(MissionBudget),
  // Fraction of a hard limit at which the runtime warns the primary agent
  // (soft threshold). 1 = warn only at the hard limit.
  soft_ratio: optional(Schema.Number),
}).annotate({ identifier: "SwarmConfig.BudgetConfig" })

export interface ApprovalConfig extends Schema.Schema.Type<typeof ApprovalConfig> {}
export const ApprovalConfig = Schema.Struct({
  spawn: Schema.Literals(["allow", "ask", "deny"]),
  workspace_write: Schema.Literals(["allow", "ask", "deny"]),
  dependency_change: Schema.Literals(["allow", "ask", "deny"]),
  git_commit: Schema.Literals(["allow", "ask", "deny"]),
  git_push: Schema.Literals(["allow", "ask", "deny"]),
  merge: Schema.Literals(["allow", "ask", "deny"]),
  external_side_effect: Schema.Literals(["allow", "ask", "deny"]),
  // Plan approval gate: if "ask", large missions pause for an explicit plan
  // checkpoint before spawning any investigators.
  mission_plan: Schema.Literals(["allow", "ask", "deny"]),
  // Integration approval gate: if "ask", presenting integration candidates
  // requires a human sign-off before they may be applied to the protected tree.
  integration: Schema.Literals(["allow", "ask", "deny"]),
  // Budget-increase gate: if "ask", a primary agent requesting more mission
  // budget pauses for human sign-off. Agents never approve their own increases.
  budget_increase: Schema.Literals(["allow", "ask", "deny"]),
}).annotate({ identifier: "SwarmConfig.ApprovalConfig" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  enabled: Schema.Boolean,
  max_agents: PositiveInt,
  max_active_agents: PositiveInt,
  max_active_coding_workspaces: PositiveInt,
  max_depth: NonNegativeInt,
  max_children_per_agent: NonNegativeInt,
  models: ModelsConfig,
  approval: ApprovalConfig,
  budget: optional(BudgetConfig),
}).annotate({ identifier: "SwarmConfig.Info" })

export const DEFAULT: Info = {
  enabled: false,
  max_agents: 10000,
  max_active_agents: 32,
  max_active_coding_workspaces: 16,
  max_depth: 12,
  max_children_per_agent: 500,
  models: {
    allowed: [],
    limits: undefined,
    providers: undefined,
    pools: undefined,
    catalog: undefined,
    routing: { policy: "balanced" },
    global_concurrency: undefined,
    mission_token_budget: undefined,
  },
  approval: {
    spawn: "allow",
    workspace_write: "allow",
    dependency_change: "ask",
    git_commit: "ask",
    git_push: "ask",
    merge: "ask",
    external_side_effect: "ask",
    mission_plan: "ask",
    integration: "ask",
    budget_increase: "ask",
  },
  budget: { default: undefined, soft_ratio: 0.8 },
}