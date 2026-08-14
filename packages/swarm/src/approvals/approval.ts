export * as SwarmApproval from "./approval"

import { Schema, DateTime } from "effect"
import { ascending } from "@opencode-ai/schema/identifier"
import { optional, DateTimeUtcFromMillis, statics, NonNegativeInt } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"
import { SwarmConfig } from "../config/config"

export const ID = Schema.String.check(Schema.isStartsWith("swp_")).pipe(
  Schema.brand("SwarmApproval.ID"),
  statics((schema) => ({ create: () => schema.make("swp_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Action = Schema.Literals([
  "spawn",
  "workspace_write",
  "dependency_change",
  "git_commit",
  "git_push",
  "merge",
  "external_side_effect",
  "mission_plan",
  "integration",
  "budget_increase",
]).annotate({ identifier: "SwarmApproval.Action" })
export type Action = typeof Action.Type

// Mirrors openSwarm permission vocabulary so approvals evaluate through the
// existing permission engine.
export const Effect = Schema.Literals(["allow", "ask", "deny"]).annotate({
  identifier: "SwarmApproval.Effect",
})
export type Effect = typeof Effect.Type

export const Reply = Schema.Literals(["once", "always", "reject"]).annotate({
  identifier: "SwarmApproval.Reply",
})
export type Reply = typeof Reply.Type

export interface Request extends Schema.Schema.Type<typeof Request> {}
export const Request = Schema.Struct({
  id: ID,
  agentID: SwarmAgent.ID,
  action: Action,
  // Human-readable summary shown in the approval UI. Sensitive values are
  // redacted before this string is built by the requester.
  summary: Schema.String,
  metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "SwarmApproval.Request" })

// ---------------------------------------------------------------------------
// Risk registry. Maps each action to its risk category. The approval engine
// never trusts LLM-supplied risk classifications: the mapping is fixed here
// and surfaced through SwarmConfig.riskRank invariants.
// ---------------------------------------------------------------------------

export const actionRisk: Readonly<Record<Action, SwarmConfig.RiskCategory>> = Object.freeze({
  spawn: "R1_isolated_local",
  workspace_write: "R1_isolated_local",
  dependency_change: "R2_project_change",
  mission_plan: "R0_read",
  integration: "R2_project_change",
  budget_increase: "R2_project_change",
  git_commit: "R3_external",
  git_push: "R3_external",
  merge: "R4_critical",
  external_side_effect: "R3_external",
})

export function riskOf(action: Action): SwarmConfig.RiskCategory {
  return actionRisk[action]
}

// ---------------------------------------------------------------------------
// Scoped grants. Grants are append-only: a higher-risk grant never broadens an
// existing lower-risk one, but the engine remembers the *highest* granted
// risk for a (mission, action pattern, resource pattern) tuple. Agents
// cannot mint grants; only the human (or scripted policy) can.
// ---------------------------------------------------------------------------

export interface Grant extends Schema.Schema.Type<typeof Grant> {}
export const Grant = Schema.Struct({
  id: ID,
  missionID: Schema.String,
  // Action patterns: literal, prefix with trailing "*", or "*" for any.
  actionPatterns: Schema.Array(Schema.String),
  // Resource patterns: file glob prefixes (e.g. "packages/runtime/**"),
  // or "*" for any. Empty = unrestricted within actionPatterns.
  resourcePatterns: Schema.Array(Schema.String),
  riskCategory: SwarmConfig.RiskCategory,
  expiresAt: optional(DateTimeUtcFromMillis),
  maxUses: optional(NonNegativeInt),
  uses: NonNegativeInt,
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "SwarmApproval.Grant" })

// Match a glob-ish pattern against a value. "*" matches any; prefix match
// when the pattern ends with "**" or a single trailing "*". Pure.
export function patternMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (pattern === value) return true
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3)
    return value === prefix || value.startsWith(prefix + "/")
  }
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2)
    return value.startsWith(prefix + "/") && !value.slice(prefix.length + 1).includes("/")
  }
  if (pattern.endsWith("*")) {
    return value.startsWith(pattern.slice(0, -1))
  }
  return false
}

export function grantMatches(grant: Grant, action: Action, resource: string, missionID: string, now: number): boolean {
  if (grant.missionID !== missionID) return false
  if (grant.expiresAt !== undefined && DateTime.toEpochMillis(grant.expiresAt) < now) return false
  if (grant.maxUses !== undefined && grant.uses >= grant.maxUses) return false
  const actionOk = grant.actionPatterns.some((p) => patternMatches(p, action))
  if (!actionOk) return false
  if (grant.resourcePatterns.length === 0) return true
  return grant.resourcePatterns.some((p) => patternMatches(p, resource))
}

// ---------------------------------------------------------------------------
// Decision engine. Pure: given configured rules + granted scopes + requested
// action, return allow/ask/deny.
// ---------------------------------------------------------------------------

export type Decision = { effect: "allow" } | { effect: "ask"; request: Omit<Request, "id" | "time"> } | { effect: "deny"; reason: string }

export interface DecisionInputs {
  readonly config: SwarmConfig.ApprovalConfig
  readonly grants: ReadonlyArray<Grant>
  readonly agentID: SwarmAgent.ID
  readonly missionID: string
  readonly action: Action
  readonly resource: string
  readonly summary: string
  readonly now: number
}

// An explicit configured `deny` is ALWAYS authoritative: grants can expand
// an approved scope but never override a denial. This is the fail-safe
// direction — a mis-typed grant cannot silently re-allow a forbidden action.
// Grants allow only when they match AND carry at least the required risk rank.
export function evaluate(input: DecisionInputs): Decision {
  const required = riskOf(input.action)
  const configured = input.config[input.action] as SwarmConfig.ApprovalConfig[Action]
  if (configured === "deny") return { effect: "deny", reason: `Action ${input.action} denied by policy` }
  const granted = input.grants.find((g) => {
    if (!grantMatches(g, input.action, input.resource, input.missionID, input.now)) return false
    return SwarmConfig.riskRank[g.riskCategory] >= SwarmConfig.riskRank[required]
  })
  if (granted !== undefined) return { effect: "allow" }
  if (configured === "allow") return { effect: "allow" }
  return {
    effect: "ask",
    request: {
      agentID: input.agentID,
      action: input.action,
      summary: input.summary,
      metadata: { resource: input.resource, risk: required },
    },
  }
}

// Consume one use of a matching grant (used by the runtime when an action is
// auto-allowed via grant). Returns true if a grant was found & consumed.
export function consumeGrant(
  grants: Grant[],
  action: Action,
  resource: string,
  missionID: string,
  now: number,
): boolean {
  const required = riskOf(action)
  const idx = grants.findIndex((g) => {
    if (!grantMatches(g, action, resource, missionID, now)) return false
    return SwarmConfig.riskRank[g.riskCategory] >= SwarmConfig.riskRank[required]
  })
  if (idx < 0) return false
  grants[idx] = { ...grants[idx]!, uses: grants[idx]!.uses + 1 }
  return true
}