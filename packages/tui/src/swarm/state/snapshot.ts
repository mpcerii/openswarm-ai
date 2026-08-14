import { SwarmRuntime } from "@opencode-ai/swarm/runtime/runtime"
import { SwarmAgent } from "@opencode-ai/swarm/agent/agent"
import { SwarmMissionBudget } from "@opencode-ai/swarm/policy/mission-budget"
import { SwarmModelHealth } from "@opencode-ai/swarm/models/health"
import { DateTime } from "effect"
import { approvalSeverity, approvalUi } from "./approvals"
import { activityFeed, HUMAN_ACTIVITY_TYPES } from "./activity"
import { primarySummary } from "./summary"
import {
  buildTreeIndexes,
  workersFromAgents,
  workerCount,
} from "./tree"
import type {
  SwarmUiAgent,
  SwarmUiApproval,
  SwarmUiArtifact,
  SwarmUiCounts,
  SwarmUiMetrics,
  SwarmUiMission,
  SwarmUiModel,
  SwarmUiResource,
  SwarmUiSnapshot,
  SwarmUiTask,
} from "./types"

export interface SnapshotOptions {
  // Fixed clock for deterministic snapshots in tests.
  now?: number
  // How many workers the "execution lanes" view presents. Derived from the
  // active bound when omitted.
  workerCount?: number
  // How many activity entries to keep (newest). Default 200.
  activityLimit?: number
}

const STATE_ORDER: SwarmAgent.State[] = [
  "created",
  "queued",
  "running",
  "waiting",
  "sleeping",
  "blocked",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "retired",
]

// snake_case agent state -> camelCase counts field.
const STATE_FIELD: Record<SwarmAgent.State, keyof SwarmUiCounts> = {
  created: "created",
  queued: "queued",
  running: "running",
  waiting: "waiting",
  sleeping: "sleeping",
  blocked: "blocked",
  awaiting_approval: "awaitingApproval",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  retired: "retired",
}

export function emptyCounts(): SwarmUiCounts {
  return {
    done: 0,
    running: 0,
    blocked: 0,
    waiting: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    awaitingApproval: 0,
    queued: 0,
    sleeping: 0,
    created: 0,
    retired: 0,
  }
}

// Project the in-process swarm kernel into the flat, indexed snapshot the TUI
// renders. Single O(n) pass over agents plus O(n) tree indexing; no I/O.
export function buildSnapshot(runtime: SwarmRuntime, opts: SnapshotOptions = {}): SwarmUiSnapshot {
  const now = opts.now ?? runtime.now()
  const agents: SwarmUiAgent[] = []
  const agentsByID = new Map<string, number>()
  const agentsByState = new Map<string, number[]>()
  const agentsByMission = new Map<string, number[]>()
  const agentsByModel = new Map<string, number[]>()
  const counts = emptyCounts()

  for (const record of runtime.state.agents.values()) {
    const info = record.info
    const index = agents.length
    agents.push({
      id: info.id,
      parent: info.parent?.agentID,
      depth: info.depth,
      role: info.role,
      state: info.state,
      mission: info.mission,
      model: info.model,
      resolvedModel: info.resolvedModel,
      sessionID: info.sessionID,
      lastError: record.lastError,
      attempts: record.attempts,
      failures: record.failures,
      workspacePath: record.workspacePath,
      created: DateTimeMillis(info.time.created),
      updated: DateTimeMillis(info.time.updated),
    })
    agentsByID.set(info.id, index)
    pushIndex(agentsByState, info.state, index)
    pushIndex(agentsByMission, info.mission, index)
    if (info.resolvedModel !== undefined) pushIndex(agentsByModel, info.resolvedModel, index)
    counts[STATE_FIELD[info.state]] += 1
  }
  counts.done = counts.completed + counts.failed + counts.cancelled + counts.retired
  counts.blocked = counts.awaitingApproval + counts.waiting

  const tree = buildTreeIndexes(agents)

  const missions: SwarmUiMission[] = [...runtime.state.missions.values()].map((m) => ({
    id: m.id,
    author: m.author,
    title: m.title,
    brief: m.brief,
    planApproved: m.planApproved,
    integrationApproved: m.integrationApproved,
    primaryAgentID: m.primaryAgentID,
  }))

  const tasks: SwarmUiTask[] = []
  const tasksByID = new Map<string, number>()
  for (const t of runtime.state.tasks.values()) {
    const index = tasks.length
    tasks.push({
      id: t.id,
      title: t.title,
      state: t.state,
      agentID: t.agentID,
      parentID: t.parentID,
      created: DateTimeMillis(t.time.created),
      updated: DateTimeMillis(t.time.updated),
    })
    tasksByID.set(t.id, index)
  }

  const artifacts: SwarmUiArtifact[] = []
  for (const record of runtime.state.artifacts.values()) {
    artifacts.push({
      id: record.artifact.id,
      agentID: record.artifact.agentID,
      taskID: record.artifact.taskID,
      kind: record.artifact.kind,
      ref: record.artifact.ref,
      summary: record.artifact.summary,
      state: record.state,
      baseCommit: record.patch.baseCommit,
      changedFiles: [...record.patch.changedFiles],
      testsExecuted: [...record.patch.testsExecuted],
      testResults: [...record.patch.testResults],
      reason: record.patch.reason,
      reviews: record.reviews.map((r) => ({
        id: r.id,
        reviewerAgentID: r.reviewerAgentID,
        objective: r.objective,
        verdict: r.verdict,
        confidence: r.confidence,
        findings: r.findings.map((f) => ({
          severity: f.severity,
          message: f.message,
          location: f.location,
        })),
      })),
      time: DateTimeMillis(record.artifact.time),
    })
  }

  const approvals: SwarmUiApproval[] = [...runtime.state.openApprovals.values()].map((req) =>
    approvalUi(req, runtime.state.agents.get(req.agentID)?.info.mission ?? "unknown"),
  )

  const models = runtime.modelsView().entries.map((m) => {
    const health = SwarmModelHealth.healthOf(runtime.state.health, m.model)
    return {
      model: m.model,
      provider: m.provider,
      authorized: m.authorized,
      pools: m.pools,
      health: m.health,
      active: m.active,
      queued: m.queued,
      concurrencyLimit: m.concurrencyLimit,
      contextWindow: m.contextWindow,
      disabled: health.disabled,
    }
  })

  const workers = workersFromAgents(agents, opts.workerCount ?? workerCount(runtime.config.max_active_agents))

  const resources: SwarmUiResource[] = []
  for (const mission of missions) {
    const view = runtime.resourceView(mission.id)
    if (view === undefined) continue
    resources.push({
      missionID: view.missionID,
      population: view.population,
      maxAgents: view.maxAgents,
      activeAgents: view.activeAgents,
      activeWorkspaces: view.activeWorkspaces,
      llmCallsConcurrent: view.llmCallsConcurrent,
      llmCallsQueued: view.llmCallsQueued,
      tokenBudget: view.tokenBudget,
      modelCalls: view.modelCalls,
      threshold: view.threshold,
      pendingApprovals: view.pendingApprovals,
    })
  }

  const m = runtime.metrics()
  const metrics: SwarmUiMetrics = m

  const queue = [...runtime.state.queue.items].map((item) => ({
    agentID: item.agentID,
    queuedAt: item.queuedAt,
    reason: item.reason,
  }))

  const activity = activityFeed(runtime.state.audit, { limit: opts.activityLimit ?? 200, now })

  const summary = primarySummary({ counts, approvals, resources, missions, artifacts, findings: metrics.findings })

  return {
    version: runtime.state.audit.events.length,
    now,
    paused: runtime.state.pauseState.paused,
    emergencyStopped: false,
    activeBound: runtime.config.max_active_agents,
    missions,
    agents,
    agentsByID,
    agentsByState,
    agentsByMission,
    agentsByModel,
    childrenByParent: tree.childrenByParent,
    roots: tree.roots,
    descendantCounts: tree.descendantCounts,
    childCounts: tree.childCounts,
    tasks,
    tasksByID,
    artifacts,
    approvals,
    activity,
    models,
    workers,
    resources,
    metrics,
    counts,
    primarySummary: summary,
    queue,
  }
}

// A snapshot that carries emergency-stop state. `buildSnapshot` is pure over
// the kernel; the bridge stamps its own emergency flag on top.
export function withEmergency(snapshot: SwarmUiSnapshot, emergencyStopped: boolean): SwarmUiSnapshot {
  return { ...snapshot, emergencyStopped }
}

// ---------------------------------------------------------------------------
// Server-backed snapshot. Builds the UI snapshot from REAL server state
// (/swarm/status + /swarm/agents). Fields the server does not yet expose
// (tasks, artifacts, reviews, approvals, activity) start empty; the core
// scheduler state — population, active bounds, per-state counts, approved
// models, agents — is genuine. Never falls back to demo data.
// ---------------------------------------------------------------------------

export interface ServerStatus {
  enabled: boolean
  models: { allowed: string[]; approved: number }
  modelStates?: Array<{ id: string; provider: string; available: boolean; authorized: boolean }>
  population: { current: number; max: number }
  active: { agents: number; max: number; llm: number; peak: number }
  workspaces: { active: number; max: number }
  agentsByState: Record<string, number>
  agentsTotal: number
  errors: string[]
}

export interface ServerAgent {
  id: string
  state: string
  role?: string
  model?: string
  sessionID?: string
  mission: string
}

export function buildSnapshotFromServer(status: ServerStatus, serverAgents: { agents: ServerAgent[] }, now: number): SwarmUiSnapshot {
  const agents: SwarmUiAgent[] = serverAgents.agents.map((a, i) => {
    const validStates = new Set<string>(SwarmAgent.State.literals)
    return {
      id: a.id,
      parent: undefined,
      depth: 1,
      role: a.role,
      state: validStates.has(a.state) ? (a.state as SwarmAgent.State) : ("queued" as SwarmAgent.State),
      mission: a.mission,
      model: a.model,
      resolvedModel: a.model,
      sessionID: a.sessionID,
      lastError: undefined,
      attempts: 0,
      failures: 0,
      workspacePath: undefined,
      created: now - i,
      updated: now,
    }
  })
  const agentsByID = new Map<string, number>()
  const agentsByState = new Map<string, number[]>()
  const agentsByMission = new Map<string, number[]>()
  const agentsByModel = new Map<string, number[]>()
  const counts = emptyCounts()
  agents.forEach((a, index) => {
    agentsByID.set(a.id, index)
    pushIndex(agentsByState, a.state, index)
    pushIndex(agentsByMission, a.mission, index)
    if (a.resolvedModel !== undefined) pushIndex(agentsByModel, a.resolvedModel, index)
    if (STATE_FIELD[a.state] !== undefined) counts[STATE_FIELD[a.state]] += 1
  })
  counts.done = counts.completed + counts.failed + counts.cancelled + counts.retired
  counts.blocked = counts.awaitingApproval + counts.waiting

  const tree = buildTreeIndexes(agents)

  const models: SwarmUiModel[] = (status.modelStates ?? []).map((s) => ({
    model: s.id,
    provider: s.provider,
    // Runtime authorization (toggled from the Models view). Unauthorized
    // models are shown but disabled so the human sees the full provider catalog.
    authorized: s.authorized,
    pools: [],
    health: s.available ? "ok" : "unavailable",
    active: 0,
    queued: 0,
    disabled: !s.authorized,
  }))

  const resources: SwarmUiResource[] = []
  const missions: SwarmUiMission[] = []
  const metrics: SwarmUiMetrics = {
    population: status.population.current,
    active: status.active.agents,
    activePeak: status.active.peak,
    queued: status.agentsByState.queued ?? 0,
    activeWorkspaces: status.workspaces.active,
    workspacePeak: 0,
    blockedApprovals: status.agentsByState.awaiting_approval ?? 0,
    artifacts: 0,
    reviews: 0,
    findings: 0,
    missions: 0,
    auditEvents: 0,
    llmConcurrent: status.active.llm,
    llmQueued: 0,
  }

  const summary = primarySummary({ counts, approvals: [], resources, missions, artifacts: [], findings: 0 })

  return {
    version: now,
    now,
    paused: false,
    emergencyStopped: false,
    activeBound: status.active.max,
    missions,
    agents,
    agentsByID,
    agentsByState,
    agentsByMission,
    agentsByModel,
    childrenByParent: tree.childrenByParent,
    roots: tree.roots,
    descendantCounts: tree.descendantCounts,
    childCounts: tree.childCounts,
    tasks: [],
    tasksByID: new Map(),
    artifacts: [],
    approvals: [],
    activity: [],
    models,
    workers: [],
    resources,
    metrics,
    counts,
    primarySummary: summary,
    queue: [],
  }
}

function pushIndex(map: Map<string, number[]>, key: string, index: number): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [index])
  else list.push(index)
}

export function DateTimeMillis(value: DateTime.DateTime): number {
  return DateTime.toEpochMillis(value)
}

export { approvalSeverity, approvalUi, HUMAN_ACTIVITY_TYPES, SwarmMissionBudget, STATE_ORDER }
