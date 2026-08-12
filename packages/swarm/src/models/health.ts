export * as SwarmModelHealth from "./health"

import { SwarmRecovery } from "../recovery/recovery"

// ---------------------------------------------------------------------------
// Operational model health. Tracks how the runtime has seen a model behave so
// the router can avoid burning budget on models that are rate-limited or
// failing. Auth failures are terminal (a bad key never becomes valid by
// retrying); disabled models are human-controlled and never scheduled.
// ---------------------------------------------------------------------------

export const Health = {
  HEALTHY: "healthy",
  RATE_LIMITED: "rate_limited",
  UNAVAILABLE: "temporarily_unavailable",
  AUTH_FAILURE: "authentication_failure",
  DISABLED: "disabled",
} as const
export type Health = (typeof Health)[keyof typeof Health]

export interface ModelHealth {
  readonly health: Health
  // Timestamp after which a rate-limited model may be tried again.
  readonly cooldownUntil: number
  readonly consecutiveFailures: number
  readonly disabled: boolean
}

export interface HealthState {
  readonly byModel: Map<string, ModelHealth>
}

export function emptyHealthState(): HealthState {
  return { byModel: new Map() }
}

export function healthOf(state: HealthState, model: string): ModelHealth {
  return state.byModel.get(model) ?? { health: "healthy", cooldownUntil: 0, consecutiveFailures: 0, disabled: false }
}

export function isHealthy(state: HealthState, model: string): boolean {
  return healthOf(state, model).health === "healthy"
}

// Is this model schedulable right now? Rate-limited models become usable again
// after their cooldown; disabled and auth-failure models never do.
export function isUsable(state: HealthState, model: string, now: number): boolean {
  const h = healthOf(state, model)
  if (h.disabled || h.health === "authentication_failure" || h.health === "temporarily_unavailable") return false
  if (h.health === "rate_limited" && now < h.cooldownUntil) return false
  return true
}

export function markHealth(state: HealthState, model: string, health: Health, now: number, cooldownMs = 0): ModelHealth {
  const prev = healthOf(state, model)
  const next: ModelHealth = {
    health,
    cooldownUntil: health === "rate_limited" ? now + cooldownMs : 0,
    consecutiveFailures: health === "healthy" ? 0 : prev.consecutiveFailures + 1,
    disabled: prev.disabled,
  }
  state.byModel.set(model, next)
  return next
}

// Health never silently re-enables a disabled model; only the human can.
export function disable(state: HealthState, model: string): void {
  const prev = healthOf(state, model)
  state.byModel.set(model, { ...prev, health: "disabled", disabled: true, cooldownUntil: 0 })
}

export function enable(state: HealthState, model: string): void {
  state.byModel.set(model, { health: "healthy", cooldownUntil: 0, consecutiveFailures: 0, disabled: false })
}

// Map a provider error message to the corresponding model health state.
// Authentication failures are recognized before generic recovery so a bad key
// never triggers a retry storm.
export function classify(error: Error | string): Health {
  const msg = typeof error === "string" ? error : error.message
  if (/unauthori[sz]ed|invalid.*(api.?key|token)|authentication|401|403|insufficient.*(permission|quota)/i.test(msg)) return "authentication_failure"
  if (SwarmRecovery.classify(error) === "rate_limit") return "rate_limited"
  if (/unavailable|503|overloaded|overload|capacity|backoff/i.test(msg)) return "temporarily_unavailable"
  return "healthy"
}
