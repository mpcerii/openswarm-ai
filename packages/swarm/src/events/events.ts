export * as SwarmEvents from "./events"

import { Schema } from "effect"
import { Event } from "@opencode-ai/schema/event"
import { optional } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"
import { SwarmApproval } from "../approvals/approval"

export const AgentSpawned = Event.define({
  type: "swarm.agent.spawned",
  durable: { version: 1, aggregate: "agentID" },
  schema: {
    agentID: SwarmAgent.ID,
    parentID: optional(SwarmAgent.ID),
    mission: Schema.String,
  },
})

export const AgentStateChanged = Event.define({
  type: "swarm.agent.state_changed",
  durable: { version: 1, aggregate: "agentID" },
  schema: {
    agentID: SwarmAgent.ID,
    from: SwarmAgent.State,
    to: SwarmAgent.State,
  },
})

export const ApprovalRequested = Event.define({
  type: "swarm.approval.requested",
  durable: { version: 1, aggregate: "agentID" },
  schema: {
    request: SwarmApproval.Request,
  },
})

export const ApprovalReplied = Event.define({
  type: "swarm.approval.replied",
  durable: { version: 1, aggregate: "agentID" },
  schema: {
    requestID: SwarmApproval.ID,
    agentID: SwarmAgent.ID,
    reply: SwarmApproval.Reply,
  },
})

export const Definitions = Event.inventory(AgentSpawned, AgentStateChanged, ApprovalRequested, ApprovalReplied)
