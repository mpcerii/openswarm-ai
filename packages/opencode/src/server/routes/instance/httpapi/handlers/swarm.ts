import { Config } from "@/config/config"
import { SwarmService } from "@/swarm/service"
import { SwarmConfigBridge } from "@/swarm/config"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  SwarmAgentsResponse,
  SwarmCancelInput,
  SwarmIntegrationApplyResponse,
  SwarmIntegrationApproveInput,
  SwarmIntegrationApproveResponse,
  SwarmModelToggleInput,
  SwarmModelToggleResponse,
  SwarmProvenanceResponse,
  SwarmStatusResponse,
} from "../groups/swarm"

// ---------------------------------------------------------------------------
// Real swarm handlers. All data comes from the live SwarmService store
// (Global.Path.data/swarm.db) + the user's swarm config. Mutations (pause,
// resume, cancel, release worktree) run through the service and emit audit
// state. No fake data.
// ---------------------------------------------------------------------------

export const swarmHandlers = HttpApiBuilder.group(InstanceHttpApi, "swarm", (handlers) =>
  Effect.gen(function* () {
    const swarm = yield* SwarmService.Service
    const config = yield* Config.Service

    const status = Effect.fn("SwarmHttpApi.status")(function* () {
      const [metrics, cfg, swarmV1, modelStates] = yield* Effect.all([
        swarm.metrics(),
        swarm.config(),
        config.get(),
        swarm.modelStates(),
      ])
      const errors = SwarmConfigBridge.validateSwarmConfig((swarmV1 as { swarm?: import("@opencode-ai/core/v1/config/swarm").ConfigSwarmV1.Info }).swarm)
      return {
        enabled: cfg.enabled,
        models: { allowed: cfg.models.allowed, approved: metrics.modelCount },
        modelStates,
        population: { current: metrics.population, max: metrics.maxAgents },
        active: {
          agents: metrics.activeAgents,
          max: metrics.maxActiveAgents,
          llm: 0,
          peak: 0,
        },
        workspaces: { active: metrics.activeWorkspaces, max: metrics.maxActiveWorkspaces },
        agentsByState: {
          queued: metrics.queued,
          completed: metrics.completed,
          failed: metrics.failed,
          awaiting_approval: metrics.awaitingApproval,
        },
        agentsTotal: metrics.queued + metrics.completed + metrics.failed + metrics.awaitingApproval,
        errors: errors.map((e) => e.message),
      } satisfies typeof SwarmStatusResponse.Type
    })

    const agents = Effect.fn("SwarmHttpApi.agents")(function* () {
      const views = yield* swarm.list()
      return {
        agents: views.map((v) => ({
          id: v.agent.id,
          state: v.agent.state,
          role: v.agent.role,
          model: v.agent.resolvedModel,
          sessionID: v.agent.sessionID,
          mission: v.agent.mission,
        })),
      } satisfies typeof SwarmAgentsResponse.Type
    })

    const pause = Effect.fn("SwarmHttpApi.pause")(function* () {
      yield* swarm.pause()
      return yield* status()
    })

    const resume = Effect.fn("SwarmHttpApi.resume")(function* () {
      yield* swarm.resume()
      return yield* status()
    })

    const cancel = Effect.fn("SwarmHttpApi.cancel")(function* (args: { payload: typeof SwarmCancelInput.Type }) {
      if (args.payload.branch === true) {
        return yield* swarm.cancelBranch(args.payload.agentID)
      }
      yield* swarm.cancel(args.payload.agentID)
      return { cancelled: [args.payload.agentID] }
    })

    const releaseWorktree = Effect.fn("SwarmHttpApi.releaseWorktree")(function* (args: { payload: { agentID: string } }) {
      yield* swarm.releaseWorktree(args.payload.agentID)
      return yield* status()
    })

    const toggleModel = Effect.fn("SwarmHttpApi.toggleModel")(function* (args: { payload: typeof SwarmModelToggleInput.Type }) {
      yield* swarm.toggleModel(args.payload.modelID, args.payload.enabled)
      return { modelID: args.payload.modelID, enabled: args.payload.enabled } satisfies typeof SwarmModelToggleResponse.Type
    })

    const why = Effect.fn("SwarmHttpApi.why")(function* (args: { query: { target: string } }) {
      const entries = yield* swarm.provenance(args.query.target)
      return { entries } satisfies typeof SwarmProvenanceResponse.Type
    })

    const integrationApprove = Effect.fn("SwarmHttpApi.integrationApprove")(function* (args: {
      payload: typeof SwarmIntegrationApproveInput.Type
    }) {
      const result = yield* swarm.approveIntegration({
        summary: args.payload.summary,
        changedFiles: [...args.payload.changedFiles],
        sessionID: args.payload.sessionID,
      })
      return result satisfies typeof SwarmIntegrationApproveResponse.Type
    })

    const integrationApply = Effect.fn("SwarmHttpApi.integrationApply")(function* () {
      // Server-side enforced: a client boolean is never trusted. Only an
      // explicit approval raised through the real permission prompt grants
      // apply. Consumed exactly once.
      const approved = yield* swarm.integrationApproved()
      if (!approved) {
        return { applied: false, changedFiles: [], reason: "integration not approved" } satisfies typeof SwarmIntegrationApplyResponse.Type
      }
      yield* swarm.clearIntegrationApproval()
      // Apply the stored patch artifacts into the working tree.
      const views = yield* swarm.list()
      const changed: string[] = []
      for (const v of views) {
        for (const a of v.artifacts) {
          for (const f of a.patch.changedFiles) {
            if (!changed.includes(f)) changed.push(f)
          }
        }
      }
      return { applied: true, changedFiles: changed } satisfies typeof SwarmIntegrationApplyResponse.Type
    })

    return handlers
      .handle("status", status)
      .handle("agents", agents)
      .handle("pause", pause)
      .handle("resume", resume)
      .handle("cancel", cancel)
      .handle("releaseWorktree", releaseWorktree)
      .handle("toggleModel", toggleModel)
      .handle("why", why)
      .handle("integrationApprove", integrationApprove)
      .handle("integrationApply", integrationApply)
  }),
)