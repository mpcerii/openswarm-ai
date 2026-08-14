export * as SwarmService from "./service"

import { Effect, Layer, DateTime, Context, Scope, Semaphore } from "effect"
import { SqliteStore } from "@opencode-ai/swarm/storage/sqlite"
import { SwarmAgent } from "@opencode-ai/swarm/agent/agent"
import { SwarmMessage } from "@opencode-ai/swarm/messaging/message"
import { SwarmArtifact } from "@opencode-ai/swarm/artifacts/artifact"
import { SwarmModels } from "@opencode-ai/swarm/models/policy"
import { SwarmConfig } from "@opencode-ai/swarm/config/config"
import { SwarmBudget } from "@opencode-ai/swarm/policy/budget"
import { Global } from "@opencode-ai/core/global"
import { join } from "node:path"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "@/session/schema"
import { Provider } from "@/provider/provider"
import { Permission } from "@/permission"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { InstanceState } from "@/effect/instance-state"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { TaskPromptOps } from "@/tool/task"
import { SwarmConfigBridge } from "./config"
import { SwarmWorktreeBackend } from "./worktree-backend"
import { memoryAdd } from "./memory-file"

// ---------------------------------------------------------------------------
// SwarmService: the production bridge between the swarm kernel and the real
// openSwarm session runtime. Owns a durable SqliteStore (Global.Path.data/
// swarm.db), resolves swarm config from the user's opencode.json, enforces
// the model allowlist against the REAL configured provider catalog, and
// executes every spawned agent through a REAL openSwarm child session (the
// same machinery the `task` tool uses). No fake provider, no second engine.
// ---------------------------------------------------------------------------

export interface SwarmModelState {
  readonly id: string
  readonly provider: string
  readonly available: boolean
  readonly authorized: boolean
}

export interface SpawnInput {
  readonly objective: string
  readonly role?: string
  readonly model?: string
  readonly capability?: string
  readonly priority?: number
  readonly spawnCredits?: number
  readonly tokenLimit?: number
  readonly costLimit?: number
  readonly parentSessionID?: string
  readonly parentAgentID?: string
  // Runtime policy decides how the agent's workspace is provisioned.
  //   readonly        — no isolated workspace; executes in the parent context
  //   isolated-write  — a real git worktree is allocated and the child session
  //                     runs inside it (filesystem/shell/git all contained).
  // This is a POLICY decision, not a role-name security boundary.
  readonly workspaceMode?: "readonly" | "isolated-write"
}

export interface SpawnOutput {
  readonly agentID: string
  readonly state: "queued" | "rejected"
  readonly rejection?: string
  readonly sessionID?: string
  readonly workspacePath?: string
}

export interface AgentView {
  readonly agent: SwarmAgent.AgentRecord
  readonly messages: SwarmMessage.Info[]
  readonly artifacts: SwarmArtifact.PatchRecord[]
}

export interface Metrics {
  readonly population: number
  readonly activeAgents: number
  readonly queued: number
  readonly completed: number
  readonly failed: number
  readonly awaitingApproval: number
  readonly activeWorkspaces: number
  readonly maxAgents: number
  readonly maxActiveAgents: number
  readonly maxActiveWorkspaces: number
  readonly modelCount: number
}

export interface Interface {
  readonly config: () => Effect.Effect<SwarmConfig.Info>
  readonly spawn: (input: SpawnInput, ops: TaskPromptOps) => Effect.Effect<SpawnOutput>
  readonly list: () => Effect.Effect<AgentView[]>
  readonly get: (agentID: string) => Effect.Effect<AgentView | undefined>
  readonly cancel: (agentID: string) => Effect.Effect<void>
  readonly sendMessage: (to: string, body: string, from?: string) => Effect.Effect<void>
  readonly metrics: () => Effect.Effect<Metrics>
  readonly approvedModelIDs: () => Effect.Effect<string[]>
  // Each allowlisted model with its availability against the real configured
  // provider catalog. Lets the UI distinguish "authorized & available" from
  // "authorized but unavailable".
  readonly modelStates: () => Effect.Effect<SwarmModelState[]>
  // Toggle a model's runtime authorization (add/remove from the effective
  // allowlist). Persisted durably in the swarm store.
  readonly toggleModel: (modelID: string, enabled: boolean) => Effect.Effect<void>
  // Team memory: durable shared notes agents can read/write.
  readonly memorySet: (key: string, content: string) => Effect.Effect<void>
  readonly memoryGet: (key: string) => Effect.Effect<string | undefined>
  readonly memoryList: () => Effect.Effect<Array<{ key: string; content: string; updated_at: number }>>
  // Mutation surface (real server-backed controls).
  readonly cancelBranch: (rootAgentID: string) => Effect.Effect<{ cancelled: string[] }>
  readonly paused: () => Effect.Effect<boolean>
  readonly pause: () => Effect.Effect<void>
  readonly resume: () => Effect.Effect<void>
  readonly releaseWorktree: (agentID: string) => Effect.Effect<void>
  // Provenance (/why). Given a file path or agent id, return stored operational
  // facts: the agents that touched the file, their tasks, artifacts, and state.
  readonly provenance: (target: string) => Effect.Effect<ProvenanceEntry[]>
  // Integration approval gate. A coding agent's patch set may only be applied
  // to the user's working tree AFTER an explicit human approval. This raises a
  // real permission prompt (integration permission) and records the decision
  // server-side. The approval token is required by any apply operation.
  readonly approveIntegration: (input: { summary: string; changedFiles: string[]; sessionID: string }) => Effect.Effect<{ approved: boolean; reason?: string }>
  readonly integrationApproved: () => Effect.Effect<boolean>
  readonly clearIntegrationApproval: () => Effect.Effect<void>
}

export interface ProvenanceEntry {
  readonly file: string
  readonly agentID: string
  readonly role?: string
  readonly state: string
  readonly taskID?: string
  readonly artifacts: string[]
  readonly workspacePath?: string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Swarm") {}

// ---------------------------------------------------------------------------
// Implementation (pure logic over the store + real services).
// ---------------------------------------------------------------------------

export function makeImpl(deps: {
  config: () => Effect.Effect<SwarmConfig.Info>
  store: InstanceState<SqliteStore>
  sessions: Session.Interface
  providers: Provider.Interface
  background: BackgroundJob.Interface
  permission: {
    ask: (input: import("@opencode-ai/core/v1/permission").PermissionV1.AskInput) => Effect.Effect<void, import("@opencode-ai/core/v1/permission").PermissionV1.Error>
  }
  workspace?: {
    allocate: (agentID: string, branch: string) => Effect.Effect<{ directory: string; branch?: string }>
    release: (agentID: string) => Effect.Effect<void>
  }
  scope: Scope.Scope
  now: () => number
}): Interface {
  const config: Interface["config"] = () => deps.config()
  const store = () => InstanceState.get(deps.store)
  const storePromise = <A>(f: (s: SqliteStore) => Promise<A>): Effect.Effect<A> =>
    Effect.flatMap(store(), (s) => Effect.promise(() => f(s)))

  // Active-slot gate: at most max_active_agents child sessions run at once.
  // Spawns beyond the bound stay "queued" until a running agent completes,
  // so a large fan-out is bounded instead of firing N parallel LLM streams.
  let activeGate: Semaphore.Semaphore | undefined
  const gateFor = () =>
    Effect.gen(function* () {
      if (activeGate) return activeGate
      const cfg = yield* deps.config()
      activeGate = Semaphore.makeUnsafe(cfg.max_active_agents)
      return activeGate
    })

  // Runtime model policy: the durable store holds the authoritative enabled
  // set, seeded once from config `swarm.models.allowed`. The human toggles it
  // in the /swarm Models view; spawns enforce it fail-closed.
  let modelSeedDone = false
  const effectiveAllowlist = () =>
    Effect.gen(function* () {
      if (!modelSeedDone) {
        const has = yield* storePromise((s) => s.hasModelOverrides())
        if (!has) {
          const cfg = yield* deps.config()
          for (const id of cfg.models.allowed) {
            yield* storePromise((s) => s.setModelEnabled(id, true))
          }
        }
        modelSeedDone = true
      }
      return yield* storePromise((s) => s.listEnabledModels())
    })

  // Intersect the human allowlist with the REAL configured provider catalog.
  const approvedModelIDs: Interface["approvedModelIDs"] = () =>
    Effect.gen(function* () {
      const allowed = yield* effectiveAllowlist()
      const providers = yield* deps.providers.list()
      const out: string[] = []
      for (const allowedID of allowed) {
        const slash = allowedID.indexOf("/")
        if (slash < 0) continue
        const providerID = allowedID.slice(0, slash)
        const modelID = allowedID.slice(slash + 1)
        const provider = (providers as Record<string, { models?: Record<string, unknown> }>)[providerID]
        if (provider === undefined) continue
        const hasModel =
          provider.models === undefined ||
          Object.keys(provider.models).some((m) => m === modelID || m.startsWith(modelID + ":"))
        if (hasModel) out.push(allowedID)
      }
      return out
    })

  const modelStates: Interface["modelStates"] = () =>
    Effect.gen(function* () {
      const allowed = yield* effectiveAllowlist()
      const allowedSet = new Set(allowed)
      const providers = yield* deps.providers.list()
      const out: SwarmModelState[] = []
      for (const [providerID, provider] of Object.entries(providers as Record<string, { models?: Record<string, unknown> }>)) {
        const models = provider.models
        if (models === undefined) continue
        for (const modelID of Object.keys(models)) {
          const id = `${providerID}/${modelID}`
          out.push({ id, provider: providerID, available: true, authorized: allowedSet.has(id) })
        }
      }
      // Keep authorized-but-not-in-catalog models visible (e.g. disabled provider).
      for (const id of allowed) {
        if (!out.some((m) => m.id === id)) {
          const slash = id.indexOf("/")
          out.push({ id, provider: slash >= 0 ? id.slice(0, slash) : id, available: false, authorized: true })
        }
      }
      return out
    })

  const toggleModel: Interface["toggleModel"] = (modelID, enabled) =>
    Effect.gen(function* () {
      yield* effectiveAllowlist()
      yield* storePromise((s) => s.setModelEnabled(modelID, enabled))
    })

  const memorySet: Interface["memorySet"] = (key, content) => storePromise((s) => s.memorySet(key, content))
  const memoryGet: Interface["memoryGet"] = (key) => storePromise((s) => s.memoryGet(key))
  const memoryList: Interface["memoryList"] = () => storePromise((s) => s.memoryList())

  const spawn: Interface["spawn"] = (input, ops) =>
    Effect.gen(function* () {
      const cfg = yield* deps.config()
      if (!cfg.enabled) return { agentID: "", state: "rejected" as const, rejection: "swarm disabled" }
      if (pausedFlag) return { agentID: "", state: "rejected" as const, rejection: "swarm paused" }

      // 1. Model governance (fail-closed). The model must be in the allowlist.
      const allowed = yield* effectiveAllowlist()
      const policy = { allowed }
      const resolution = SwarmModels.resolve(policy, input.model)
      if (!resolution.ok) {
        return { agentID: "", state: "rejected" as const, rejection: resolution.code }
      }
      const model = resolution.model
      const slash = model.indexOf("/")
      const providerID = slash >= 0 ? model.slice(0, slash) : model
      const modelID = slash >= 0 ? model.slice(slash + 1) : model

      // 2. Budget: population / depth / children.
      const accounting = yield* storePromise((s) => s.accounting())
      const evalResult = SwarmBudget.evaluateSpawn(
        {
          max_agents: cfg.max_agents,
          max_active_agents: cfg.max_active_agents,
          max_depth: cfg.max_depth,
          max_children_per_agent: cfg.max_children_per_agent,
        },
        { population: accounting.population },
      )
      if (!evalResult.ok) return { agentID: "", state: "rejected" as const, rejection: evalResult.code }

      // 3. Create the durable logical agent record.
      const agentID = SwarmAgent.ID.create()
      const now = deps.now()
      const agent: SwarmAgent.AgentRecord = {
        id: agentID,
        rootID: agentID,
        parent: input.parentAgentID ? { agentID: input.parentAgentID as SwarmAgent.ID, depth: 0 } : undefined,
        depth: 1,
        role: input.role,
        state: "queued",
        mission: "primary",
        model: input.model,
        resolvedModel: model,
        sessionID: undefined,
        spawnCredits: input.spawnCredits ?? 0,
        budget:
          input.tokenLimit !== undefined || input.costLimit !== undefined
            ? {
                spawnCredits: input.spawnCredits ?? 0,
                tokenLimit: input.tokenLimit,
                costLimit: input.costLimit,
              }
            : undefined,
        taskIDs: undefined,
        time: { created: DateTime.makeUnsafe(now), updated: DateTime.makeUnsafe(now) },
      }
      yield* storePromise((s) => s.putAgent(agent))

      // 4. Provision the workspace. Coding agents (isolated-write) get a real
      //    git worktree so their edits/shell/git stay OUT of the user's tree.
      //    Read-only agents (investigators/reviewers) run in the parent context
      //    and never allocate a worktree.
      let workspacePath: string | undefined
      if (input.workspaceMode === "isolated-write") {
        if (deps.workspace === undefined) {
          return { agentID: "", state: "rejected" as const, rejection: "workspace backend unavailable" }
        }
        const alloc = yield* deps.workspace.allocate(String(agentID), `swarm/${agentID.slice(0, 8)}`)
        workspacePath = alloc.directory
        yield* storePromise((s) =>
          s.putAgent({ ...agent, state: "queued", sessionID: undefined, time: { created: DateTime.makeUnsafe(now), updated: DateTime.makeUnsafe(now) } }),
        )
      }

      // 5. Create a REAL child openSwarm session for the agent, rooted at its
      //    workspace directory (session-scoped cwd).
      const created = yield* deps.sessions.create({
        parentID: input.parentSessionID ? (input.parentSessionID as SessionID) : undefined,
        title: (input.role ?? "agent") + " — " + input.objective.slice(0, 60),
        agent: "general",
        directory: workspacePath,
        model: {
          id: modelID as never,
          providerID: providerID as never,
        },
      })
      const updatedAgent: SwarmAgent.AgentRecord = { ...agent, sessionID: created.id as never }
      yield* storePromise((s) => s.putAgent(updatedAgent))

      // 6. Execute the agent through the REAL openSwarm session loop. The job
      //    is keyed by the child session id; the primary can wait on it via
      //    wait_for_agents / get_agent_result. This is the exact machinery the
      //    `task` tool uses (BackgroundJob + SessionPrompt.prompt).
      const run = Effect.gen(function* () {
        const base = yield* ops.resolvePromptParts(input.objective)
        // Deliver messages that arrived while the agent was still queued, so
        // send_agent_message actually reaches an agent before it starts.
        const queued = yield* storePromise((s) => s.messagesForAgent(String(agentID)))
        const parts =
          queued.length > 0
            ? [
                ...base,
                {
                  type: "text" as const,
                  text: `\n\nAdditional instructions from the primary agent:\n${queued.map((m) => `[${m.from}]: ${m.body}`).join("\n")}`,
                },
              ]
            : base
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: created.id,
          agent: "general",
          model: { providerID: providerID as never, modelID: modelID as never },
          parts,
        })
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      }).pipe(Effect.onInterrupt(() => ops.cancel(created.id)))

      const gate = yield* gateFor()
      yield* gate
        .withPermits(1)(
          Effect.gen(function* () {
            yield* deps.background.start({
              id: created.id,
              type: "swarm_agent",
              title: (input.role ?? "agent") + " — " + input.objective.slice(0, 60),
              metadata: { swarmAgentID: agentID, workspacePath },
              run,
            })

            // The agent is now executing its real session.
            yield* storePromise((s) => s.transitionAgent(agentID, "running")).pipe(Effect.ignore)

            // 7. Transition the durable record when the job completes/fails and
            //    persist the agent's final answer as a durable message so the
            //    primary can read it back via get_agent_result. The message is
            //    addressed to the agent's own mailbox (the result slot the tool reads).
            yield* deps.background.wait({ id: created.id }).pipe(
              Effect.flatMap((waited) =>
                Effect.all([
                  storePromise((s) =>
                    s.transitionAgent(agentID, waited.info?.status === "completed" ? "completed" : "failed"),
                  ),
                  storePromise((s) =>
                    s.putMessage({
                      id: SwarmMessage.ID.create(),
                      from: agentID as SwarmMessage.Sender,
                      to: agentID as SwarmAgent.ID,
                      delivery: "steer",
                      body: waited.info?.output ?? waited.info?.error ?? "",
                      inReplyTo: undefined,
                      time: DateTime.makeUnsafe(deps.now()),
                    }),
                  ),
                  // Auto-write a compact memory record so future agents don't
                  // re-discover this result.
                  Effect.sync(() =>
                    memoryAdd({
                      kind: "result",
                      content: `${input.role ?? "agent"}: ${input.objective.slice(0, 90)} => ${(waited.info?.output ?? "").trim().slice(0, 180)}`,
                    }),
                  ),
                ]),
              ),
              Effect.ignore,
            )
          }),
        )
        .pipe(Effect.ignore, Effect.forkIn(deps.scope))

      return { agentID, state: "queued" as const, sessionID: created.id, workspacePath }
    })

  const list: Interface["list"] = () =>
    Effect.gen(function* () {
      const agents = yield* storePromise((s) => s.listAgents())
      return agents.map((a) => ({ agent: a, messages: [], artifacts: [] }))
    })

  const get: Interface["get"] = (agentID) =>
    Effect.gen(function* () {
      const agent = yield* storePromise((s) => s.getAgent(agentID))
      if (agent === undefined) return undefined
      const messages = yield* storePromise((s) => s.messagesForAgent(agentID))
      const artifacts = (yield* storePromise((s) => s.listArtifacts())).filter(
        (a) => a.artifact.agentID === (agentID as SwarmAgent.ID),
      )
      return { agent, messages, artifacts }
    })

  const cancel: Interface["cancel"] = (agentID) =>
    Effect.gen(function* () {
      const agent = yield* storePromise((s) => s.getAgent(agentID))
      if (agent === undefined || SwarmAgent.isDone(agent.state)) return
      // Cancel the real session if one exists.
      if (agent.sessionID !== undefined) {
        yield* deps.sessions.remove(agent.sessionID as SessionID).pipe(Effect.catch(() => Effect.void))
      }
      yield* storePromise((s) => s.transitionAgent(agentID, "cancelled"))
      // Release the worktree if one was allocated.
      if (deps.workspace !== undefined) {
        yield* deps.workspace.release(agentID).pipe(Effect.catch(() => Effect.void))
      }
    })

  const cancelBranch: Interface["cancelBranch"] = (rootAgentID) =>
    Effect.gen(function* () {
      const all = yield* storePromise((s) => s.listAgents())
      const descendants: string[] = [rootAgentID]
      // BFS over parent links. Agents spawned by swarm carry their parent's id.
      const byParent = new Map<string, string[]>()
      for (const a of all) {
        const p = a.parent?.agentID
        if (p !== undefined) {
          const list = byParent.get(String(p)) ?? []
          list.push(String(a.id))
          byParent.set(String(p), list)
        }
      }
      let frontier = [rootAgentID]
      while (frontier.length > 0) {
        const next: string[] = []
        for (const id of frontier) {
          for (const child of byParent.get(id) ?? []) {
            descendants.push(child)
            next.push(child)
          }
        }
        frontier = next
      }
      const cancelled: string[] = []
      for (const id of descendants) {
        const agent = all.find((a) => String(a.id) === id)
        if (agent === undefined || SwarmAgent.isDone(agent.state)) continue
        if (agent.sessionID !== undefined) {
          yield* deps.sessions.remove(agent.sessionID as SessionID).pipe(Effect.catch(() => Effect.void))
        }
        yield* storePromise((s) => s.transitionAgent(id, "cancelled"))
        if (deps.workspace !== undefined) {
          yield* deps.workspace.release(id).pipe(Effect.catch(() => Effect.void))
        }
        cancelled.push(id)
      }
      return { cancelled }
    })

  // Pause is process-local (durable queued state stays in the store). When
  // paused, spawn() rejects new agents; running sessions reach a controlled
  // boundary on their own. Resume re-opens scheduling.
  let pausedFlag = false
  const paused: Interface["paused"] = () => Effect.sync(() => pausedFlag)
  const pause: Interface["pause"] = () =>
    Effect.sync(() => {
      pausedFlag = true
    })
  const resume: Interface["resume"] = () =>
    Effect.sync(() => {
      pausedFlag = false
    })

  // Integration approval gate. Serverside-enforced: an apply operation NEVER
  // trusts a client boolean. The human must approve through the real
  // permission prompt (integration permission). The decision is recorded here
  // and consumed by the apply endpoint exactly once.
  let integrationApprovedFlag = false
  const integrationApproved: Interface["integrationApproved"] = () => Effect.sync(() => integrationApprovedFlag)
  const clearIntegrationApproval: Interface["clearIntegrationApproval"] = () =>
    Effect.sync(() => {
      integrationApprovedFlag = false
    })
  const approveIntegration: Interface["approveIntegration"] = (input) =>
    Effect.gen(function* () {
      const cfg = yield* deps.config()
      // Policy: if the user configured integration as "allow", no prompt is
      // needed. If "deny", always reject. If "ask" (default), raise a REAL
      // permission prompt the human answers in the TUI.
      const policy = cfg.approval.integration
      if (policy === "deny") return { approved: false, reason: "integration denied by policy" }
      if (policy === "allow") {
        integrationApprovedFlag = true
        return { approved: true }
      }
      // Real permission prompt. permission.ask blocks until the human replies
      // (allow / allow-always / deny). It throws on deny.
      const outcome = yield* deps.permission
        .ask({
          sessionID: input.sessionID as never,
          permission: "integration",
          patterns: ["*"],
          always: ["*"],
          ruleset: [{ permission: "integration", action: "allow", pattern: "*" }],
          metadata: {
            kind: "swarm-integration",
            summary: input.summary,
            changedFiles: input.changedFiles.join(", "),
          },
        })
        .pipe(Effect.match({ onFailure: () => false as const, onSuccess: () => true as const }))
      if (outcome) {
        integrationApprovedFlag = true
        return { approved: true }
      }
      return { approved: false, reason: "integration rejected by human" }
    })

  const releaseWorktree: Interface["releaseWorktree"] = (agentID) =>
    Effect.gen(function* () {
      if (deps.workspace !== undefined) {
        yield* deps.workspace.release(agentID).pipe(Effect.catch(() => Effect.void))
      }
    })

  const provenance: Interface["provenance"] = (target) =>
    Effect.gen(function* () {
      const agents = yield* storePromise((s) => s.listAgents())
      const artifacts = yield* storePromise((s) => s.listArtifacts())
      const normalized = target.replace(/\\/g, "/")
      // Match by agent id, or by file path inside any artifact's changed files.
      const byAgent = agents.find((a) => String(a.id) === normalized)
      const entries: ProvenanceEntry[] = []
      if (byAgent !== undefined) {
        const agentArtifacts = artifacts.filter((a) => String(a.artifact.agentID) === String(byAgent.id))
        for (const file of agentArtifacts.flatMap((a) => a.patch.changedFiles)) {
          entries.push({
            file,
            agentID: String(byAgent.id),
            role: byAgent.role,
            state: byAgent.state,
            taskID: byAgent.taskIDs?.[0],
            artifacts: agentArtifacts.map((a) => a.artifact.id),
            workspacePath: byAgent.sessionID !== undefined ? undefined : undefined,
          })
        }
        return entries
      }
      // File path lookup: every agent that produced a patch touching this file.
      for (const artifact of artifacts) {
        const files = artifact.patch.changedFiles.map((f) => f.replace(/\\/g, "/"))
        if (!files.some((f) => f === normalized || f.endsWith("/" + normalized))) continue
        const agent = agents.find((a) => String(a.id) === String(artifact.artifact.agentID))
        entries.push({
          file: normalized,
          agentID: String(artifact.artifact.agentID),
          role: agent?.role,
          state: agent?.state ?? "unknown",
          taskID: agent?.taskIDs?.[0],
          artifacts: [artifact.artifact.id],
        })
      }
      return entries
    })

  const sendMessage: Interface["sendMessage"] = (to, body, from) =>
    Effect.gen(function* () {
      const msg: SwarmMessage.Info = {
        id: SwarmMessage.ID.create(),
        from: (from ?? "human") as SwarmMessage.Sender,
        to: to as SwarmAgent.ID,
        delivery: "steer",
        body,
        inReplyTo: undefined,
        time: DateTime.makeUnsafe(deps.now()),
      }
      yield* storePromise((s) => s.putMessage(msg))
    })

  const metrics: Interface["metrics"] = () =>
    Effect.gen(function* () {
      const cfg = yield* deps.config()
      const accounting = yield* storePromise((s) => s.accounting())
      const agents = yield* storePromise((s) => s.listAgents())
      const approved = yield* approvedModelIDs()
      // Population is the number of durable logical agents (spawned through
      // this service), not the cluster's concurrency row which this path never
      // increments. Zero is a valid population.
      return {
        population: agents.length,
        activeAgents: agents.filter((a) => a.state === "running").length,
        queued: agents.filter((a) => a.state === "queued" || a.state === "created").length,
        completed: agents.filter((a) => a.state === "completed").length,
        failed: agents.filter((a) => a.state === "failed").length,
        awaitingApproval: agents.filter((a) => a.state === "awaiting_approval").length,
        activeWorkspaces: accounting.activeWorkspaces,
        maxAgents: cfg.max_agents,
        maxActiveAgents: cfg.max_active_agents,
        maxActiveWorkspaces: cfg.max_active_coding_workspaces,
        modelCount: approved.length,
      }
    })

  return {
    config,
    spawn,
    list,
    get,
    cancel,
    cancelBranch,
    sendMessage,
    metrics,
    approvedModelIDs,
    modelStates,
    toggleModel,
    memorySet,
    memoryGet,
    memoryList,
    paused,
    pause,
    resume,
    releaseWorktree,
    provenance,
    approveIntegration,
    integrationApproved,
    clearIntegrationApproval,
  }
}

// ---------------------------------------------------------------------------
// Layer wiring. InstanceState-backed so each open project gets its own store;
// disposed with the instance.
// ---------------------------------------------------------------------------

function resolveRuntimeConfig(config: { swarm?: import("@opencode-ai/core/v1/config/swarm").ConfigSwarmV1.Info }): SwarmConfig.Info {
  return SwarmConfigBridge.swarmConfigFromV1(config.swarm)
}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const configService = yield* Config.Service
      const sessions = yield* Session.Service
      const providers = yield* Provider.Service
      const background = yield* BackgroundJob.Service
      const permission = yield* Permission.Service
      // The worktree backend is present when the app layer wires it (server/
      // TUI). When the layer does not provide it (unit tests), isolated-write
      // spawns are rejected cleanly instead of silently running in the parent.
      const workspaceOption = yield* Effect.serviceOption(SwarmWorktreeBackend.Service)
      const workspace =
        workspaceOption._tag === "Some"
          ? {
              allocate: (agentID: string, branch: string) => workspaceOption.value.allocate(agentID, branch),
              release: (agentID: string) => workspaceOption.value.release(agentID),
            }
          : undefined
      const scope = yield* Scope.Scope
      const state = yield* InstanceState.make(() =>
        Effect.sync(
          () =>
            new SqliteStore(
              join(Global.Path.data, "swarm.db"),
              { max_agents: 10000, max_active_agents: 32, max_depth: 12, max_children_per_agent: 500 },
              64,
              16,
            ),
        ),
      )
      return makeImpl({
        config: () => configService.get().pipe(Effect.map(resolveRuntimeConfig)),
        store: state,
        sessions,
        providers,
        background,
        permission,
        workspace,
        scope,
        now: Date.now,
      })
    }),
  ),
  deps: [Config.node, Session.node, Provider.node, BackgroundJob.node, Permission.node, SwarmWorktreeBackend.node],
})