export * as SwarmModelCatalog from "./catalog"

import { SwarmConfig } from "../config/config"

// ---------------------------------------------------------------------------
// Runtime model catalog. Built from the human allowlist plus reliable metadata
// the user declares in `swarm.models.catalog`. Dynamic provider behavior is
// NOT stored here — the provider abstraction supplies it. `enabled` is exactly
// allowlist membership: a model listed in `catalog` but absent from `allowed`
// never appears, so an empty allowlist yields an empty catalog (fail-closed).
// ---------------------------------------------------------------------------

export interface ModelCapabilities {
  readonly text: true
  readonly tools?: boolean
  readonly vision?: boolean
  readonly reasoning?: boolean
}

export interface SwarmModel {
  readonly id: string
  // Provider segment of "provider/model" (never hardcoded; derived from id).
  readonly provider: string
  readonly contextWindow?: number
  readonly capabilities: ModelCapabilities
  readonly enabled: boolean
  // Rough user-declared cheapness ranking (lower = cheaper) and latency hint
  // (ms). Only present when the human configured them.
  readonly priority?: number
  readonly latencyMs?: number
}

// Split "provider/model" into its provider segment. A bare id is its own
// provider (defensive; real ids are always "provider/model").
export function providerOf(id: string): string {
  const idx = id.indexOf("/")
  if (idx <= 0) return id
  return id.slice(0, idx)
}

export function buildCatalog(config: SwarmConfig.Info): SwarmModel[] {
  const allowed = new Set(config.models.allowed)
  const catalog = config.models.catalog
  return [...allowed].map((id) => {
    const entry = catalog?.[id]
    return {
      id,
      provider: providerOf(id),
      contextWindow: entry?.context_window,
      capabilities: {
        text: true,
        tools: entry?.capabilities?.tools,
        vision: entry?.capabilities?.vision,
        reasoning: entry?.capabilities?.reasoning,
      },
      enabled: allowed.has(id),
      priority: entry?.priority,
      latencyMs: entry?.latency_ms,
    }
  })
}

export function modelFor(catalog: readonly SwarmModel[], id: string): SwarmModel | undefined {
  return catalog.find((m) => m.id === id)
}

export function isEnabled(model: SwarmModel | undefined): boolean {
  return model !== undefined && model.enabled
}

// A task needing `contextSize` tokens never selects a model whose window is
// smaller: the router compacts/splits or picks a larger-context allowed model
// instead of blindly truncating critical input.
export function fitsContext(model: SwarmModel, contextSize?: number): boolean {
  if (contextSize === undefined || contextSize <= 0) return true
  if (model.contextWindow === undefined) return true
  return contextSize <= model.contextWindow
}

// Known model capability classes narrow the candidate set. Unknown names (e.g.
// worker capabilities like "docker" or "sandbox") pass through the model
// router unchanged — worker-level capability routing handles them separately.
const MODEL_CAPABILITIES = new Set(["text", "tools", "vision", "reasoning", "large-context"])

export function hasCapability(model: SwarmModel, capability?: string): boolean {
  if (capability === undefined || capability === "text") return true
  if (!MODEL_CAPABILITIES.has(capability)) return true
  if (capability === "tools") return model.capabilities.tools ?? false
  if (capability === "vision") return model.capabilities.vision ?? false
  if (capability === "reasoning") return model.capabilities.reasoning ?? false
  if (capability === "large-context") return model.contextWindow !== undefined && model.contextWindow >= 64_000
  return true
}
