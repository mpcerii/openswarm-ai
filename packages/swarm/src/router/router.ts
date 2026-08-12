export * as SwarmModelRouter from "./router"

import { SwarmConfig } from "../config/config"
import { SwarmModelCatalog } from "../models/catalog"
import { SwarmPools } from "../models/pools"
import { SwarmModelHealth } from "../models/health"

// ---------------------------------------------------------------------------
// Model router. PURE: given a snapshot of human policy, model catalog, health,
// concurrency and remaining budget it picks the model a spawn should use. It
// never mutates anything and never trusts LLM-supplied tool arguments — model
// selection is always derived from the human allowlist + pools. The runtime
// (local or control plane) calls route() and emits the `model.selected` audit
// event with only the operational reason.
// ---------------------------------------------------------------------------

export interface RoutingContext {
  readonly policy: SwarmConfig.RoutingPolicy
  readonly catalog: readonly SwarmModelCatalog.SwarmModel[]
  readonly pools?: Readonly<Record<string, readonly string[]>>
  readonly health: SwarmModelHealth.HealthState
  readonly now: number
  // model id -> active concurrent calls (governor snapshot).
  readonly concurrency: ReadonlyMap<string, number>
  // provider -> active concurrent calls.
  readonly providerConcurrency: ReadonlyMap<string, number>
  readonly limits?: Readonly<Record<string, SwarmConfig.ModelLimits>>
  readonly providerLimits?: Readonly<Record<string, SwarmConfig.ProviderLimits>>
}

export interface RoutingInput {
  // Informational only; used in the audit reason, never to bypass policy.
  readonly objective?: string
  readonly taskType?: string
  readonly requestedCapability?: string
  readonly requestedPool?: string
  // Explicit "provider/model". Always checked against the allowlist.
  readonly requestedModel?: string
  readonly contextSize?: number
  readonly requiresTools?: boolean
  readonly priority?: number
  // Remaining mission budget snapshot; 0 model calls blocks routing.
  readonly remainingBudget?: { readonly modelCalls?: number; readonly tokens?: number }
}

export type RoutingResult =
  | {
      ok: true
      model: string
      reason: string
      fallbackOrder: string[]
      policy: SwarmConfig.RoutingPolicy
    }
  | { ok: false; code: "no_models_allowed" | "pool_not_found" | "pool_empty" | "model_not_allowed" | "no_eligible_model" | "context_overflow" | "no_remaining_budget" | "policy_requires_explicit"; reason: string }
  | { ok: false; code: "rate_limited"; reason: string; candidates?: string[] }

export function route(ctx: RoutingContext, input: RoutingInput): RoutingResult {
  if (input.remainingBudget?.modelCalls !== undefined && input.remainingBudget.modelCalls <= 0) {
    return { ok: false, code: "no_remaining_budget", reason: "mission model-call budget exhausted" }
  }

  // Explicit-only policy never selects autonomously.
  if (ctx.policy === "explicit-only" && input.requestedModel === undefined) {
    return { ok: false, code: "policy_requires_explicit", reason: "explicit-only policy requires an explicit model request" }
  }

  if (ctx.catalog.length === 0) return { ok: false, code: "no_models_allowed", reason: "no models allowed" }

  if (input.requestedModel !== undefined) {
    const requested = SwarmModelCatalog.modelFor(ctx.catalog, input.requestedModel)
    if (requested === undefined || !requested.enabled) {
      return { ok: false, code: "model_not_allowed", reason: `${input.requestedModel} is not human-authorized` }
    }
    // Honor the explicit (authorized) request when it is usable and fits.
    const eligible = eligibleFor(ctx, requested, input)
    if (eligible.ok) return select(ctx, [requested], input, `explicit=${input.requestedModel}`)
    if (ctx.policy === "explicit-only") return toFailure(eligible)
    // Otherwise fall back within the pool the model belongs to (never beyond).
    return fallbackFor(ctx, input, requested)
  }

  const candidates = candidatesFor(ctx, input)
  if (!("models" in candidates)) return candidates
  return select(ctx, candidates.models, input, `pool=${candidates.pool}`)
}

// ---------------------------------------------------------------------------
// Candidate construction
// ---------------------------------------------------------------------------

function candidatesFor(ctx: RoutingContext, input: RoutingInput):
  | { models: SwarmModelCatalog.SwarmModel[]; pool: string }
  | RoutingResult {
  if (input.requestedPool !== undefined) {
    const allowed = new Set(ctx.catalog.filter((m) => m.enabled).map((m) => m.id))
    const members = ctx.pools?.[input.requestedPool]
    if (members === undefined) return { ok: false, code: "pool_not_found", reason: `pool "${input.requestedPool}" is not configured` }
    const eligible = members.filter((id) => allowed.has(id))
    if (eligible.length === 0) return { ok: false, code: "pool_empty", reason: `pool "${input.requestedPool}" has no human-authorized models` }
    return { models: eligible.map((id) => SwarmModelCatalog.modelFor(ctx.catalog, id)!).filter((m) => m !== undefined), pool: input.requestedPool }
  }
  const base = input.requestedCapability !== undefined
    ? ctx.catalog.filter((m) => m.enabled && SwarmModelCatalog.hasCapability(m, input.requestedCapability))
    : ctx.catalog.filter((m) => m.enabled)
  if (base.length === 0 && input.requestedCapability !== undefined) {
    return { ok: false, code: "no_eligible_model", reason: `no allowed model provides capability "${input.requestedCapability}"` }
  }
  return { models: base, pool: "any" }
}

// ---------------------------------------------------------------------------
// Eligibility & selection
// ---------------------------------------------------------------------------

type Eligibility =
  | { ok: true }
  | { ok: false; code: "context_overflow" | "rate_limited" | "no_eligible_model" | "temporarily_unavailable" | "concurrency"; reason: string }

// Map a per-model eligibility verdict to a routing failure. Concurrency
// saturation and temporary unavailability collapse into the closest public
// codes so the caller sees a stable vocabulary.
function toFailure(eligibility: Extract<Eligibility, { ok: false }>): RoutingResult {
  if (eligibility.code === "context_overflow") return { ok: false, code: "context_overflow", reason: eligibility.reason }
  if (eligibility.code === "rate_limited" || eligibility.code === "temporarily_unavailable") {
    return { ok: false, code: "rate_limited", reason: eligibility.reason }
  }
  return { ok: false, code: "no_eligible_model", reason: eligibility.reason }
}

function eligibleFor(ctx: RoutingContext, model: SwarmModelCatalog.SwarmModel, input: RoutingInput): Eligibility {
  if (input.requiresTools === true && !(model.capabilities.tools ?? false)) {
    return { ok: false, code: "no_eligible_model", reason: `${model.id} does not support tools` }
  }
  if (input.requestedCapability !== undefined && !SwarmModelCatalog.hasCapability(model, input.requestedCapability)) {
    return { ok: false, code: "no_eligible_model", reason: `${model.id} lacks capability "${input.requestedCapability}"` }
  }
  if (!SwarmModelCatalog.fitsContext(model, input.contextSize)) {
    return { ok: false, code: "context_overflow", reason: `${model.id} context ${model.contextWindow ?? "?"} < ${input.contextSize}` }
  }
  if (!SwarmModelHealth.isUsable(ctx.health, model.id, ctx.now)) {
    const h = SwarmModelHealth.healthOf(ctx.health, model.id)
    if (h.health === "authentication_failure") return { ok: false, code: "no_eligible_model", reason: `${model.id} failed authentication (disabled)` }
    if (h.health === "temporarily_unavailable") return { ok: false, code: "temporarily_unavailable", reason: `${model.id} temporarily unavailable` }
    return { ok: false, code: "rate_limited", reason: `${model.id} rate-limited until ${h.cooldownUntil}` }
  }
  if (concurrencyBlocked(ctx, model)) {
    return { ok: false, code: "concurrency", reason: `${model.id} at concurrency limit` }
  }
  return { ok: true }
}

function concurrencyBlocked(ctx: RoutingContext, model: SwarmModelCatalog.SwarmModel): boolean {
  const modelLimit = ctx.limits?.[model.id]?.concurrency
  if (modelLimit !== undefined && (ctx.concurrency.get(model.id) ?? 0) >= modelLimit) return true
  const providerLimit = ctx.providerLimits?.[model.provider]?.concurrency
  if (providerLimit !== undefined && (ctx.providerConcurrency.get(model.provider) ?? 0) >= providerLimit) return true
  return false
}

function fallbackFor(ctx: RoutingContext, input: RoutingInput, requested: SwarmModelCatalog.SwarmModel): RoutingResult {
  // Without a requested pool, the fallback spans the whole allowlist — every
  // candidate is human-authorized, so this never bypasses the allowlist.
  const members = input.requestedPool !== undefined ? ctx.pools?.[input.requestedPool] : undefined
  const allowed = new Set(ctx.catalog.filter((m) => m.enabled).map((m) => m.id))
  const inPool = (members ?? [...allowed]).filter((id) => allowed.has(id) && id !== requested.id)
  const models = inPool
    .map((id) => SwarmModelCatalog.modelFor(ctx.catalog, id)!)
    .filter((m) => m !== undefined && eligibleFor(ctx, m, input).ok)
  const ordered = sortByPolicy(ctx, models)
  const first = ordered[0]
  if (first === undefined) {
    const primary = eligibleFor(ctx, requested, input)
    if (!primary.ok) {
      if (primary.code === "context_overflow") return contextOverflow(ctx, input)
      if (primary.code === "rate_limited" || primary.code === "temporarily_unavailable") return rateLimited(ctx, input, requested)
    }
    return { ok: false, code: "no_eligible_model", reason: `no eligible fallback for ${requested.id}` }
  }
  return {
    ok: true,
    model: first.id,
    reason: `explicit=${requested.id} unavailable, fallback within authorized pool`,
    fallbackOrder: ordered.slice(1).map((m) => m.id),
    policy: ctx.policy,
  }
}

function select(ctx: RoutingContext, models: SwarmModelCatalog.SwarmModel[], input: RoutingInput, source: string): RoutingResult {
  const eligible = models.filter((m) => eligibleFor(ctx, m, input).ok)
  const ordered = sortByPolicy(ctx, eligible)
  const first = ordered[0]
  if (first === undefined) {
    const failed = models.map((m) => eligibleFor(ctx, m, input)).filter((f): f is Extract<Eligibility, { ok: false }> => !f.ok)
    if (failed.some((f) => f.code === "context_overflow")) return contextOverflow(ctx, input)
    if (failed.some((f) => f.code === "rate_limited" || f.code === "temporarily_unavailable")) return rateLimited(ctx, input, models[0])
    return { ok: false, code: "no_eligible_model", reason: "no eligible model for this request" }
  }
  return { ok: true, model: first.id, reason: `${source} policy=${ctx.policy} capability=${input.requestedCapability ?? "text"} context=${input.contextSize ?? "any"} tools=${input.requiresTools ?? false}`, fallbackOrder: ordered.slice(1).map((m) => m.id), policy: ctx.policy }
}

// ---------------------------------------------------------------------------
// Failure construction
// ---------------------------------------------------------------------------

function contextOverflow(ctx: RoutingContext, input: RoutingInput): RoutingResult {
  const candidates = ctx.catalog.filter((m) => m.enabled && SwarmModelCatalog.fitsContext(m, input.contextSize)).map((m) => m.id)
  const largest = ctx.catalog.reduce((max, m) => (m.enabled && (m.contextWindow ?? 0) > max ? m.contextWindow ?? 0 : max), 0)
  const hint = candidates.length > 0
    ? ` (larger-context allowed models: ${candidates.join(", ")})`
    : largest > 0
      ? ` (largest allowed window is ${largest})`
      : ""
  return {
    ok: false,
    code: "context_overflow",
    reason: `no allowed model fits context ${input.contextSize}${hint}`,
  }
}

function rateLimited(ctx: RoutingContext, input: RoutingInput, first: SwarmModelCatalog.SwarmModel | undefined): RoutingResult {
  const candidates = ctx.catalog.filter((m) => m.enabled && SwarmModelHealth.isUsable(ctx.health, m.id, ctx.now)).map((m) => m.id)
  return {
    ok: false,
    code: "rate_limited",
    reason: `all eligible models rate-limited or unavailable${first !== undefined ? ` (${first.id})` : ""}`,
    ...(candidates.length > 0 ? { candidates } : {}),
  }
}

// ---------------------------------------------------------------------------
// Policy ordering. Deterministic: ties break by catalog (allowlist) order.
// ---------------------------------------------------------------------------

function sortByPolicy(ctx: RoutingContext, models: readonly SwarmModelCatalog.SwarmModel[]): SwarmModelCatalog.SwarmModel[] {
  const rank = new Map(models.map((m, i) => [m.id, i]))
  const sorted = [...models].sort((a, b) => {
    const cmp = policyCompare(ctx, a, b)
    if (cmp !== 0) return cmp
    return (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)
  })
  return sorted
}

function policyCompare(ctx: RoutingContext, a: SwarmModelCatalog.SwarmModel, b: SwarmModelCatalog.SwarmModel): number {
  const policy = ctx.policy
  if (policy === "prefer-cheapest") return costRank(a) - costRank(b)
  if (policy === "prefer-lowest-latency") return latencyRank(a) - latencyRank(b)
  if (policy === "prefer-strongest") return strengthRank(b) - strengthRank(a)
  // balanced: least-loaded first, then cheaper.
  const loadA = ctx.concurrency.get(a.id) ?? 0
  const loadB = ctx.concurrency.get(b.id) ?? 0
  if (loadA !== loadB) return loadA - loadB
  return costRank(a) - costRank(b)
}

function costRank(model: SwarmModelCatalog.SwarmModel): number {
  return model.priority ?? 10_000
}

function latencyRank(model: SwarmModelCatalog.SwarmModel): number {
  return model.latencyMs ?? 10_000
}

function strengthRank(model: SwarmModelCatalog.SwarmModel): number {
  return model.priority ?? 0
}
