export * as SwarmTools from "./tools"

import * as Tool from "@/tool/tool"
import { Effect, Schema } from "effect"
import { ToolJsonSchema } from "@/tool/json-schema"
import { SwarmService } from "./service"
import type { TaskPromptOps } from "@/tool/task"
import { Config } from "@/config/config"
import { SwarmConfigBridge } from "./config"

// ---------------------------------------------------------------------------
// Real swarm tools for the primary agent. Registered only when
// `swarm.enabled` is true (see tool/registry.ts). Every tool routes through
// the SwarmService production API — the LLM never instantiates runtime
// classes. Spawned agents execute through the REAL openSwarm session loop via
// the same promptOps machinery the `task` tool uses.
// ---------------------------------------------------------------------------

const id = "spawn_agent"

function describeOutput(agentId: string, state: string, extra = ""): string {
  return [
    `<swarm_agent agentId="${agentId}" state="${state}">`,
    ...(extra ? [extra] : []),
    "</swarm_agent>",
  ].join("\n")
}

export const SpawnAgentTool = Tool.define(
  id,
  Effect.gen(function* () {
    const swarm = yield* SwarmService.Service
    const config = yield* Config.Service

    const Parameters = Schema.Struct({
      objective: Schema.String.annotate({ description: "The task the new agent should perform" }),
      role: Schema.optional(Schema.String).annotate({
        description: "Optional role metadata (e.g. investigator, implementer, reviewer). Roles are advisory.",
      }),
      model: Schema.optional(Schema.String).annotate({
        description: 'Exact "provider/model" the agent should use. Must be in swarm.models.allowed or the spawn is rejected.',
      }),
      capability: Schema.optional(Schema.String).annotate({ description: "Optional capability hint" }),
      priority: Schema.optional(Schema.Number).annotate({ description: "Optional scheduling priority" }),
      workspace_mode: Schema.optional(
        Schema.Literals(["readonly", "isolated-write"]),
      ).annotate({
        description:
          "How the agent's workspace is provisioned. 'isolated-write' allocates a real git worktree so all edits/shell/git stay out of the user's tree. 'readonly' (default) runs in the parent context. Coding agents should use isolated-write.",
      }),
      budget: Schema.optional(
        Schema.Struct({
          spawnCredits: Schema.optional(Schema.Int),
          tokenLimit: Schema.optional(Schema.Int),
          costLimit: Schema.optional(Schema.Number),
        }),
      ).annotate({ description: "Optional delegated budget for this agent's own children" }),
    })

    const run = Effect.fn("SwarmTools.spawn_agent.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      if (cfg.swarm?.enabled !== true) {
        return {
          title: "Swarm disabled",
          metadata: { agentId: "", sessionId: undefined },
          output: "Swarm is disabled (swarm.enabled is not true). Enable it in opencode.json to spawn agents.",
        }
      }

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) {
        return {
          title: "spawn_agent",
          metadata: { agentId: "", sessionId: undefined },
          output: "spawn_agent requires an active session (promptOps missing).",
        }
      }

      const result = yield* swarm.spawn(
        {
          objective: params.objective,
          role: params.role,
          model: params.model,
          capability: params.capability,
          priority: params.priority,
          spawnCredits: params.budget?.spawnCredits,
          tokenLimit: params.budget?.tokenLimit,
          costLimit: params.budget?.costLimit,
          parentSessionID: ctx.sessionID as string,
          workspaceMode: params.workspace_mode,
        },
        ops,
      )

      if (result.state === "rejected") {
        return {
          title: "spawn_agent rejected",
          metadata: { agentId: "", sessionId: undefined },
          output: `Spawning agent was rejected: ${result.rejection ?? "unknown reason"}`,
        }
      }
      return {
        title: "spawn_agent",
        metadata: {
          agentId: result.agentID,
          sessionId: result.sessionID,
        },
        output: describeOutput(result.agentID, result.state),
      }
    })

    return {
      description: [
        `Spawn a new logical swarm agent. The agent will execute through a real openSwarm session using a real model.`,
        `Model policy is enforced server-side: the requested model must be in "swarm.models.allowed", otherwise the spawn is rejected.`,
        `The agent runs asynchronously; use get_agent_result to fetch its result, or cancel_agent to cancel it.`,
      ].join(" "),
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

const id2 = "spawn_agents"

export const SpawnAgentsTool = Tool.define(
  id2,
  Effect.gen(function* () {
    const swarm = yield* SwarmService.Service

    const Parameters = Schema.Struct({
      objectives: Schema.Array(Schema.String).annotate({ description: "List of objectives, one per agent" }),
      count: Schema.optional(Schema.Int).annotate({
        description:
          "Total number of agents to spawn. Defaults to objectives.length. When larger than the list, objectives are cycled so a single objective can fan out to many agents (e.g. count=100 with one objective spawns 100 agents).",
      }),
      role: Schema.optional(Schema.String).annotate({ description: "Role metadata applied to all spawned agents" }),
      model: Schema.optional(Schema.String).annotate({ description: "Model for all spawned agents (must be allowed)" }),
    })

    const run = Effect.fn("SwarmTools.spawn_agents.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) {
        return {
          title: "spawn_agents",
          metadata: {},
          output: "spawn_agents requires an active session (promptOps missing).",
        }
      }
      const count = params.count ?? params.objectives.length
      if (count <= 0 || params.objectives.length === 0) {
        return { title: "spawn_agents", metadata: {}, output: "No objectives provided." }
      }
      const lines: string[] = []
      for (let i = 0; i < count; i++) {
        const base = params.objectives[i % params.objectives.length]!
        const objective = count > params.objectives.length ? `${base} (agent ${i + 1}/${count})` : base
        const result = yield* swarm.spawn(
          { objective, role: params.role, model: params.model, parentSessionID: ctx.sessionID as string },
          ops,
        )
        if (result.state === "rejected") {
          lines.push(`- ${objective.slice(0, 40)}… REJECTED (${result.rejection ?? "unknown"})`)
        } else {
          lines.push(`- ${objective.slice(0, 40)}… spawned ${result.agentID}`)
        }
      }
      return {
        title: "spawn_agents",
        metadata: {},
        output: `<swarm_agents>\n${lines.join("\n")}\n</swarm_agents>`,
      }
    })

    return {
      description: "Spawn several swarm agents in one call. Each objective creates a separate agent.",
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

const id3 = "list_agents"

export const ListAgentsTool = Tool.define(
  id3,
  Effect.gen(function* () {
    const swarm = yield* SwarmService.Service

    const Parameters = Schema.Struct({
      state: Schema.optional(Schema.String).annotate({
        description: "Optional filter by state (queued, running, completed, failed, cancelled, awaiting_approval)",
      }),
      limit: Schema.optional(Schema.Int).annotate({ description: "Maximum rows to return", default: 50 }),
    })

    const run = Effect.fn("SwarmTools.list_agents.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
    ) {
      const views = yield* swarm.list()
      const filtered = views.filter((v) => params.state === undefined || v.agent.state === params.state)
      const limited = filtered.slice(0, params.limit ?? 50)
      const rows = limited
        .map((v) => `${v.agent.id}  ${v.agent.state.padEnd(18)}  ${v.agent.role ?? "agent"}  ${v.agent.resolvedModel ?? ""}`)
      return {
        title: "list_agents",
        metadata: {},
        output: rows.length === 0 ? "No agents found." : `<agents count="${filtered.length}">\n${rows.join("\n")}\n</agents>`,
      }
    })

    return {
      description: "List swarm agents and their current states.",
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) => run(params).pipe(Effect.orDie),
    }
  }),
)

const id4 = "send_agent_message"

export const SendAgentMessageTool = Tool.define(
  id4,
  Effect.gen(function* () {
    const swarm = yield* SwarmService.Service

    const Parameters = Schema.Struct({
      to: Schema.String.annotate({ description: "Target agent id (from list_agents)" }),
      message: Schema.String.annotate({ description: "Message body delivered to the agent's mailbox" }),
    })

    const run = Effect.fn("SwarmTools.send_agent_message.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
    ) {
      yield* swarm.sendMessage(params.to, params.message, "primary")
      return {
        title: "send_agent_message",
        metadata: { to: params.to },
        output: `Message delivered to agent ${params.to}.`,
      }
    })

    return {
      description: "Send a message into an agent's mailbox. Delivered on its next scheduling slot.",
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) => run(params).pipe(Effect.orDie),
    }
  }),
)

const id5 = "get_agent_result"

export const GetAgentResultTool = Tool.define(
  id5,
  Effect.gen(function* () {
    const swarm = yield* SwarmService.Service

    const Parameters = Schema.Struct({
      agentId: Schema.String.annotate({ description: "Agent id from list_agents" }),
    })

    const run = Effect.fn("SwarmTools.get_agent_result.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
    ) {
      const view = yield* swarm.get(params.agentId)
      if (view === undefined) {
        return { title: "get_agent_result", metadata: {}, output: `No such agent: ${params.agentId}` }
      }
      const a = view.agent
      const lines = [
        `agentId: ${a.id}`,
        `state: ${a.state}`,
        `role: ${a.role ?? "agent"}`,
        `model: ${a.resolvedModel ?? "unknown"}`,
        `sessionId: ${a.sessionID ?? "none"}`,
      ]
      if (view.messages.length > 0) {
        lines.push(`messages: ${view.messages.length}`)
        for (const m of view.messages.slice(-3)) lines.push(`  [${m.from}] ${m.body}`)
      }
      if (view.artifacts.length > 0) lines.push(`artifacts: ${view.artifacts.map((x) => x.artifact.id).join(", ")}`)
      return {
        title: "get_agent_result",
        metadata: {},
        output: `<agent_result>\n${lines.join("\n")}\n</agent_result>`,
      }
    })

    return {
      description: "Fetch a spawned agent's current state and result summary.",
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) => run(params).pipe(Effect.orDie),
    }
  }),
)

const id6 = "cancel_agent"

export const CancelAgentTool = Tool.define(
  id6,
  Effect.gen(function* () {
    const swarm = yield* SwarmService.Service

    const Parameters = Schema.Struct({
      agentId: Schema.String.annotate({ description: "Agent id to cancel" }),
    })

    const run = Effect.fn("SwarmTools.cancel_agent.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
    ) {
      yield* swarm.cancel(params.agentId)
      return {
        title: "cancel_agent",
        metadata: { agentId: params.agentId },
        output: `Cancelled agent ${params.agentId}.`,
      }
    })

    return {
      description: "Cancel a swarm agent. Terminal agents are unaffected.",
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) => run(params).pipe(Effect.orDie),
    }
  }),
)

const id7 = "wait_for_agents"

export const WaitForAgentsTool = Tool.define(
  id7,
  Effect.gen(function* () {
    const swarm = yield* SwarmService.Service

    const Parameters = Schema.Struct({
      agentIds: Schema.Array(Schema.String).annotate({ description: "Agent ids to wait for" }),
      timeout: Schema.optional(Schema.Int).annotate({
        description: "Approximate wait budget in ms. Defaults to 120000 (2 min).",
        default: 120000,
      }),
    })

    const run = Effect.fn("SwarmTools.wait_for_agents.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
    ) {
      // In the real runtime the primary yields its turn here; children keep
      // executing in their own sessions. We poll the durable agent state
      // (bounded by the timeout) instead of making the primary loop.
      const deadline = Date.now() + (params.timeout ?? 120000)
      const pending = new Set(params.agentIds)
      let views = yield* swarm.list()
      const find = (id: string) => views.find((v) => v.agent.id === id)
      for (;;) {
        for (const id of [...pending]) {
          const v = find(id)
          if (v !== undefined && ["completed", "failed", "cancelled"].includes(v.agent.state)) pending.delete(id)
        }
        if (pending.size === 0 || Date.now() > deadline) break
        yield* Effect.sleep("250 millis")
        views = yield* swarm.list()
      }
      const done = params.agentIds
        .map((id) => {
          const v = find(id)
          return `${id} -> ${v?.agent.state ?? "missing"}`
        })
        .join("\n")
      return {
        title: "wait_for_agents",
        metadata: {},
        output: pending.size === 0 ? `<agents_done>\n${done}\n</agents_done>` : `<agents_timeout>\n${done}\n</agents_timeout>`,
      }
    })

    return {
      description:
        "Wait for one or more spawned swarm agents to finish. Blocks the current turn (with a timeout); returns each agent's final state.",
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) => run(params).pipe(Effect.orDie),
    }
  }),
)

const id8 = "swarm_memory_set"

export const MemorySetTool = Tool.define(
  id8,
  Effect.gen(function* () {
    const swarm = yield* SwarmService.Service
    const Parameters = Schema.Struct({
      key: Schema.String.annotate({ description: "Short identifier for this note (e.g. 'decision:auth-flow')" }),
      content: Schema.String.annotate({ description: "The note content other agents should know" }),
    })
    const run = Effect.fn("SwarmTools.memory_set.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
    ) {
      yield* swarm.memorySet(params.key, params.content)
      return { title: "swarm_memory_set", metadata: {}, output: `Memory "${params.key}" saved.` }
    })
    return {
      description: "Persist a note into the shared team memory so spawned agents can read it later.",
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) => run(params).pipe(Effect.orDie),
    }
  }),
)

const id9 = "swarm_memory_get"

export const MemoryGetTool = Tool.define(
  id9,
  Effect.gen(function* () {
    const swarm = yield* SwarmService.Service
    const Parameters = Schema.Struct({
      key: Schema.optional(Schema.String).annotate({ description: "Note identifier. Omit to list all notes." }),
    })
    const run = Effect.fn("SwarmTools.memory_get.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
    ) {
      if (params.key !== undefined) {
        const content = yield* swarm.memoryGet(params.key)
        return { title: "swarm_memory_get", metadata: {}, output: content ?? `No memory under "${params.key}".` }
      }
      const entries = yield* swarm.memoryList()
      const lines = entries.map((e) => `${e.key}: ${e.content.slice(0, 400)}`)
      return { title: "swarm_memory_get", metadata: {}, output: lines.length > 0 ? lines.join("\n") : "Team memory is empty." }
    })
    return {
      description: "Read a note from the shared team memory, or list all notes when no key is given.",
      parameters: Parameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) => run(params).pipe(Effect.orDie),
    }
  }),
)

// All swarm tools registered when swarm.enabled. The list is stable so the
// registry can spread it into builtins conditionally.
export const all = [SpawnAgentTool, SpawnAgentsTool, ListAgentsTool, SendAgentMessageTool, GetAgentResultTool, CancelAgentTool, WaitForAgentsTool, MemorySetTool, MemoryGetTool]

export function swarmToolIds(): string[] {
  return all.map((t) => t.id)
}

export function isSwarmToolID(id: string): boolean {
  return all.some((t) => t.id === id)
}

export function isSwarmEnabled(cfg: { swarm?: { enabled?: boolean } }): boolean {
  return cfg.swarm?.enabled === true
}

export function validateSwarmConfig(cfg: { swarm?: import("@opencode-ai/core/v1/config/swarm").ConfigSwarmV1.Info }): string | undefined {
  const errors = SwarmConfigBridge.validateSwarmConfig(cfg.swarm)
  if (errors.length === 0) return undefined
  return errors.map((e) => e.message).join("\n")
}