export * as SwarmRecovery from "./recovery"

import { SwarmAgent } from "../agent/agent"

// Bounded retries. Failure recovery NEVER creates infinite retry loops: each
// retry policy carries an explicit max-attempts cap and an exponential
// backoff ceiling. The runtime consults this before re-queueing an agent.

export type FailureClass =
  | "model_request_failed"
  | "rate_limit"
  | "agent_crash"
  | "agent_cancelled"
  | "test_failure"
  | "merge_conflict"
  | "process_restart"
  | "model_unavailable"
  | "authentication_failure"
  | "malformed_tool_output"
  | "unknown"

export interface RetryPolicy {
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly backoffFactor: number
  // Failures treated as terminal — no retry is ever attempted for these.
  readonly terminal: ReadonlySet<FailureClass>
}

export const DEFAULT_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  backoffFactor: 2,
  // Auth failures are terminal: a bad key will not become valid on retry and
  // retrying only burns budget against an unauthorized provider.
  terminal: new Set<FailureClass>(["agent_cancelled", "authentication_failure"]),
}

// Per-failure-class overrides so e.g. rate limits jitter further but still
// bound at the same ceiling. The runtime composes these at evaluation time.
export function policyFor(failure: FailureClass): RetryPolicy {
  if (failure === "rate_limit") return { ...DEFAULT_POLICY, maxAttempts: 4, baseDelayMs: 500 }
  if (failure === "merge_conflict") return { ...DEFAULT_POLICY, maxAttempts: 2 }
  if (failure === "model_unavailable") return { ...DEFAULT_POLICY, maxAttempts: 3, baseDelayMs: 1000 }
  if (failure === "malformed_tool_output") return { ...DEFAULT_POLICY, maxAttempts: 2 }
  return DEFAULT_POLICY
}

export function classify(error: Error | string): FailureClass {
  const msg = typeof error === "string" ? error : error.message
  if (/rate[\s_-]?limit|429|too many requests/i.test(msg)) return "rate_limit"
  if (/unauthori[sz]ed|invalid.*(api.?key|token)|authentication|401|403/i.test(msg)) return "authentication_failure"
  if (/cancel/i.test(msg)) return "agent_cancelled"
  if (/merge[\s_-]?(conflict|fail)|conflicting changes/i.test(msg)) return "merge_conflict"
  if (/model unavailable|no.*models? allowed/i.test(msg)) return "model_unavailable"
  if (/test.*fail|failed.*test/i.test(msg)) return "test_failure"
  if (/malformed|invalid tool (output|args)|json.*parse/i.test(msg)) return "malformed_tool_output"
  if (/restart|respawn|fatal/i.test(msg)) return "process_restart"
  if (/crash|killed|dead/i.test(msg)) return "agent_crash"
  if (/timeout|abort|fetch failed|network/i.test(msg)) return "model_request_failed"
  return "unknown"
}

export interface NextStep {
  // "retry" re-queues the agent under the existing failure count; "give_up"
  // marks it failed and routes the parent to a reassignment path; "block"
  // leaves the agent in `awaiting_approval` waiting on a human decision.
  readonly action: "retry" | "give_up" | "block"
  readonly delayMs: number
  readonly reason: string
}

export function nextStep(policy: RetryPolicy, failure: FailureClass, attemptsSoFar: number): NextStep {
  if (policy.terminal.has(failure)) return { action: "give_up", delayMs: 0, reason: `${failure} is terminal` }
  if (attemptsSoFar >= policy.maxAttempts) {
    return { action: "give_up", delayMs: 0, reason: `max attempts reached (${policy.maxAttempts})` }
  }
  // Exponential backoff with deterministic jitter source supplied by caller.
  const exponent = Math.min(attemptsSoFar, 16) // overflow guard
  const raw = policy.baseDelayMs * Math.pow(policy.backoffFactor, exponent)
  const delay = Math.min(raw, policy.maxDelayMs)
  return { action: "retry", delayMs: delay, reason: `${failure} retry #${attemptsSoFar + 1}` }
}

// Reassign a task failed-by agent A to a fresh agent B. The kernel uses this
// to keep the mission moving when a child agent crashes: the task record is
// preserved and re-attached. Pure: returns the update descriptors.
export interface Reassignment {
  readonly taskID: string
  readonly fromAgent: SwarmAgent.ID
  readonly toAgent: SwarmAgent.ID
  readonly attempts: number
  readonly reason: string
}

export type ReassignmentOutcome = { kind: "reassign"; re: Reassignment } | { kind: "fail" }