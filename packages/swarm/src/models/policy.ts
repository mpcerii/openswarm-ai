export * as SwarmModels from "./policy"

import { Schema } from "effect"

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
