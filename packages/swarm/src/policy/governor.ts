export * as SwarmGovernor from "./governor"

// ---------------------------------------------------------------------------
// Rate-limit governor. Provider/model concurrency controls with bounded
// backpressure: when a reservation is denied the caller QUEUES the agent (the
// runtime re-enqueues it, it is never hard-failed). Pure decision logic over
// a mutable state container — exactly the SwarmBudget.Accounts pattern — so
// the local runtime and the distributed control plane share one implementation.
//
// Windows are only enforced when the human declares them (requests_per_window
// + window_ms, tokens_per_window + window_ms); the governor never guesses
// provider limits it cannot verify.
// ---------------------------------------------------------------------------

export interface GovernorLimits {
  readonly globalConcurrent?: number
  readonly provider?: Readonly<Record<string, ProviderLimit>>
  readonly model?: Readonly<Record<string, ModelLimit>>
}

export interface ProviderLimit {
  readonly concurrency?: number
  readonly requestsPerWindow?: number
  readonly tokensPerWindow?: number
  readonly windowMs?: number
}

export interface ModelLimit {
  readonly concurrency?: number
  readonly requestsPerWindow?: number
  readonly tokensPerWindow?: number
  readonly windowMs?: number
}

export interface Slot {
  active: number
  requests: number[]
  tokens: Array<{ at: number; tokens: number }>
}

export interface GovernorState {
  readonly byModel: Map<string, Slot>
  readonly byProvider: Map<string, Slot>
  globalActive: number
  globalPeak: number
}

export function emptyGovernorState(): GovernorState {
  return { byModel: new Map(), byProvider: new Map(), globalActive: 0, globalPeak: 0 }
}

export interface ReserveRequest {
  readonly model: string
  readonly provider: string
  readonly now: number
}

export type ReserveDecision =
  | { kind: "allow" }
  | { kind: "queue"; code: "global_concurrency" | "provider_concurrency" | "model_concurrency" | "rate_limited" | "tokens_exhausted"; backoffMs: number }

// Fixed modest backoff for concurrency saturation so requeues do not spin.
const CONCURRENCY_BACKOFF_MS = 250

// Try to reserve one concurrent call slot. Denial always returns a queue
// decision with an explicit backoff; the caller re-enqueues, never fails.
export function tryReserve(state: GovernorState, limits: GovernorLimits, req: ReserveRequest): ReserveDecision {
  if (limits.globalConcurrent !== undefined && state.globalActive >= limits.globalConcurrent) {
    return { kind: "queue", code: "global_concurrency", backoffMs: CONCURRENCY_BACKOFF_MS }
  }
  const pLimit = limits.provider?.[req.provider]
  const pSlot = slotFor(state, req.provider, state.byProvider)
  if (pLimit?.concurrency !== undefined && pSlot.active >= pLimit.concurrency) {
    return { kind: "queue", code: "provider_concurrency", backoffMs: CONCURRENCY_BACKOFF_MS }
  }
  const mLimit = limits.model?.[req.model]
  const mSlot = slotFor(state, req.model, state.byModel)
  if (mLimit?.concurrency !== undefined && mSlot.active >= mLimit.concurrency) {
    return { kind: "queue", code: "model_concurrency", backoffMs: CONCURRENCY_BACKOFF_MS }
  }
  const pWindow = windowCheck(pSlot, pLimit, req.now)
  if (pWindow !== undefined) return pWindow
  const mWindow = windowCheck(mSlot, mLimit, req.now)
  if (mWindow !== undefined) return mWindow

  pSlot.active += 1
  pSlot.requests.push(req.now)
  mSlot.active += 1
  mSlot.requests.push(req.now)
  state.globalActive += 1
  if (state.globalActive > state.globalPeak) state.globalPeak = state.globalActive
  return { kind: "allow" }
}

export function release(state: GovernorState, req: { readonly model: string; readonly provider: string }): void {
  const pSlot = state.byProvider.get(req.provider)
  if (pSlot && pSlot.active > 0) pSlot.active -= 1
  const mSlot = state.byModel.get(req.model)
  if (mSlot && mSlot.active > 0) mSlot.active -= 1
  if (state.globalActive > 0) state.globalActive -= 1
}

// Record token throughput after a run. Consumption never blocks here; the
// token window is enforced at the next reservation.
export function recordTokens(state: GovernorState, req: { readonly model: string; readonly provider: string; readonly tokens: number; readonly now: number }): void {
  if (req.tokens <= 0) return
  const pSlot = slotFor(state, req.provider, state.byProvider)
  pSlot.tokens.push({ at: req.now, tokens: req.tokens })
  const mSlot = slotFor(state, req.model, state.byModel)
  mSlot.tokens.push({ at: req.now, tokens: req.tokens })
}

export function activeByModel(state: GovernorState): ReadonlyMap<string, number> {
  return new Map([...state.byModel.entries()].map(([k, v]) => [k, v.active]))
}

export function activeByProvider(state: GovernorState): ReadonlyMap<string, number> {
  return new Map([...state.byProvider.entries()].map(([k, v]) => [k, v.active]))
}

export function globalActive(state: GovernorState): number {
  return state.globalActive
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slotFor(state: GovernorState, key: string, map: Map<string, Slot>): Slot {
  let slot = map.get(key)
  if (slot === undefined) {
    slot = { active: 0, requests: [], tokens: [] }
    map.set(key, slot)
  }
  return slot
}

// Enforce requests-per-window and token-per-window when the human declared
// them. Returns a queue decision when the window is full.
function windowCheck(slot: Slot, limit: ProviderLimit | ModelLimit | undefined, now: number): ReserveDecision | undefined {
  if (limit === undefined) return undefined
  if (limit.windowMs === undefined) return undefined
  const cutoff = now - limit.windowMs
  slot.requests = slot.requests.filter((ts) => ts >= cutoff)
  if (limit.requestsPerWindow !== undefined && slot.requests.length >= limit.requestsPerWindow) {
    const oldest = slot.requests[0] ?? now
    return { kind: "queue", code: "rate_limited", backoffMs: Math.max(1, oldest + limit.windowMs - now) }
  }
  if (limit.tokensPerWindow !== undefined) {
    slot.tokens = slot.tokens.filter((t) => t.at >= cutoff)
    const used = slot.tokens.reduce((n, t) => n + t.tokens, 0)
    if (used >= limit.tokensPerWindow) {
      const oldest = slot.tokens[0]?.at ?? now
      return { kind: "queue", code: "tokens_exhausted", backoffMs: Math.max(1, oldest + limit.windowMs - now) }
    }
  }
  return undefined
}
