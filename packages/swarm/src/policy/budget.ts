export * as SwarmBudget from "./budget"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, DateTimeUtcFromMillis } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"

export interface Limits extends Schema.Schema.Type<typeof Limits> {}
export const Limits = Schema.Struct({
  max_agents: PositiveInt,
  max_active_agents: PositiveInt,
  max_depth: NonNegativeInt,
  max_children_per_agent: NonNegativeInt,
}).annotate({ identifier: "SwarmBudget.Limits" })

// Per-agent capacity receipt recorded when a spawn atomically consumes
// global budget. Children can never mint capacity: only the swarm runtime
// creates receipts.
export interface AgentBudget extends Schema.Schema.Type<typeof AgentBudget> {}
export const AgentBudget = Schema.Struct({
  agentID: SwarmAgent.ID,
  depth: NonNegativeInt,
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "SwarmBudget.AgentBudget" })

export interface SpawnUsage {
  readonly population: number
  readonly parentDepth?: number
  readonly parentChildren?: number
}

export type SpawnRejection = "population_exceeded" | "depth_exceeded" | "children_exceeded"
export type SpawnEvaluation = { ok: true; depth: number } | { ok: false; code: SpawnRejection }

// Depth of the primary/root agent is 0; a spawned child sits one deeper.
export function evaluateSpawn(limits: Limits, usage: SpawnUsage, count = 1): SpawnEvaluation {
  if (usage.population + count > limits.max_agents) return { ok: false, code: "population_exceeded" }
  const depth = (usage.parentDepth ?? 0) + 1
  if (depth > limits.max_depth) return { ok: false, code: "depth_exceeded" }
  if ((usage.parentChildren ?? 0) + count > limits.max_children_per_agent)
    return { ok: false, code: "children_exceeded" }
  return { ok: true, depth }
}

export function canAdmit(limits: Limits, activeAgents: number) {
  return activeAgents < limits.max_active_agents
}
