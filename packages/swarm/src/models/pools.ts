export * as SwarmPools from "./pools"

import { SwarmConfig } from "../config/config"

// ---------------------------------------------------------------------------
// Semantic model pools. The HUMAN defines which allowed models belong to which
// pool (`swarm.models.pools`); the router only ever intersects a requested
// pool with the allowlist. A pool is never auto-populated by an agent request,
// and pool members outside `allowed` are silently ignored (fail-closed).
// ---------------------------------------------------------------------------

export type PoolResolution =
  | { ok: true; models: string[]; pool: string }
  | { ok: false; code: "no_models_allowed" | "pool_not_found" | "pool_empty" | "model_not_allowed" }

// Resolve the models eligible for a semantic pool. Without a pool, the whole
// (non-empty) allowlist is eligible.
export function resolvePool(config: SwarmConfig.Info, pool?: string): PoolResolution {
  const allowed = config.models.allowed
  if (allowed.length === 0) return { ok: false, code: "no_models_allowed" }
  if (pool === undefined) return { ok: true, models: [...allowed], pool: "any" }
  const members = config.models.pools?.[pool]
  if (members === undefined) return { ok: false, code: "pool_not_found" }
  const eligible = members.filter((m) => allowed.includes(m))
  if (eligible.length === 0) return { ok: false, code: "pool_empty" }
  return { ok: true, models: eligible, pool }
}

export function poolMembers(config: SwarmConfig.Info, pool: string): readonly string[] {
  return config.models.pools?.[pool] ?? []
}

// Every pool (in declared order) that contains the given model. Used by the
// TUI "Models" view to show which pools a model belongs to.
export function poolsForModel(config: SwarmConfig.Info, model: string): string[] {
  const pools = config.models.pools
  if (pools === undefined) return []
  return Object.keys(pools).filter((pool) => (pools[pool] ?? []).includes(model))
}
