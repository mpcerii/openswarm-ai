import type { SwarmAgent } from "@opencode-ai/swarm/agent/agent"

// ---------------------------------------------------------------------------
// UI-facing snapshot types. Flat, rendering-friendly projections of the
// swarm kernel state — the TUI never touches the kernel's Maps directly, and
// the view logic operates on these plain shapes so it stays testable without
// a terminal. The builder lives in ./snapshot.
// ---------------------------------------------------------------------------

export interface SwarmUiAgent {
  id: string
  parent?: string
  depth: number
  role?: string
  state: SwarmAgent.State
  mission: string
  model?: string
  resolvedModel?: string
  sessionID?: string
  lastError?: string
  attempts: number
  failures: number
  workspacePath?: string
  created: number
  updated: number
}

export interface SwarmUiMission {
  id: string
  author: string
  title: string
  brief: string
  planApproved: boolean
  integrationApproved: boolean
  primaryAgentID: string
}

export interface SwarmUiTask {
  id: string
  title: string
  state: string
  agentID: string
  parentID?: string
  created: number
  updated: number
}

export interface SwarmUiReviewFinding {
  severity: string
  message: string
  location?: string
}

export interface SwarmUiReview {
  id: string
  reviewerAgentID: string
  objective: string
  verdict: string
  confidence: number
  findings: SwarmUiReviewFinding[]
}

export interface SwarmUiArtifact {
  id: string
  agentID: string
  taskID?: string
  kind: string
  ref: string
  summary?: string
  state: "proposed" | "reviewed" | "approved" | "rejected" | "integrated"
  baseCommit: string
  changedFiles: string[]
  testsExecuted: string[]
  testResults: string[]
  reason: string
  reviews: SwarmUiReview[]
  time: number
}

export type ApprovalSeverity = "LOW" | "MEDIUM" | "HIGH"

export interface SwarmUiApproval {
  id: string
  agentID: string
  action: string
  summary: string
  resource?: string
  risk: string
  mission: string
  time: number
  severity: ApprovalSeverity
  // Budget-increase requests carry usage context so the human can judge.
  budgetReason?: string
  budgetUsedCalls?: number
  budgetUsedTokens?: number
}

export type AlertSeverity = "info" | "warning" | "high" | "critical"

export interface SwarmUiActivity {
  id: number
  type: string
  time: number
  agentID?: string
  missionID?: string
  taskID?: string
  artifactID?: string
  title: string
  detail?: string
  severity: AlertSeverity
}

export interface SwarmUiModel {
  model: string
  provider: string
  authorized: boolean
  pools: string[]
  health: string
  active: number
  queued: number
  concurrencyLimit?: number
  contextWindow?: number
  disabled: boolean
}

export interface SwarmUiWorker {
  id: string
  name: string
  health: string
  active: number
  max: number
  ratio: number
  llmActive: number
}

export interface SwarmUiBudgetBar {
  used: number
  limit?: number
  ratio: number
}

export interface SwarmUiResource {
  missionID: string
  population: number
  maxAgents?: number
  activeAgents: number
  activeWorkspaces: number
  llmCallsConcurrent: number
  llmCallsQueued: number
  tokenBudget: SwarmUiBudgetBar
  modelCalls: SwarmUiBudgetBar
  threshold: "ok" | "soft" | "hard"
  pendingApprovals: number
}

export interface SwarmUiMetrics {
  population: number
  active: number
  activePeak: number
  queued: number
  activeWorkspaces: number
  workspacePeak: number
  blockedApprovals: number
  artifacts: number
  reviews: number
  findings: number
  missions: number
  auditEvents: number
  llmConcurrent: number
  llmQueued: number
}

// Per-state population histogram plus the working-set breakdown used by the
// status bar and the overview tab.
export interface SwarmUiCounts {
  done: number
  running: number
  blocked: number
  waiting: number
  completed: number
  failed: number
  cancelled: number
  awaitingApproval: number
  queued: number
  sleeping: number
  created: number
  retired: number
}

export interface SwarmUiPrimarySummary {
  lines: string[]
  bugsConfirmed: number
  fixesReady: number
  approvalsNeeded: number
  pendingBudget: number
}

export interface SwarmUiSnapshot {
  version: number
  now: number
  paused: boolean
  emergencyStopped: boolean
  activeBound: number
  missions: SwarmUiMission[]
  agents: SwarmUiAgent[]
  // Indexes over `agents` (indexes into the array above).
  agentsByID: Map<string, number>
  agentsByState: Map<string, number[]>
  agentsByMission: Map<string, number[]>
  agentsByModel: Map<string, number[]>
  childrenByParent: Map<string, number[]>
  roots: number[]
  descendantCounts: Map<number, number>
  childCounts: Map<number, number>
  tasks: SwarmUiTask[]
  tasksByID: Map<string, number>
  artifacts: SwarmUiArtifact[]
  approvals: SwarmUiApproval[]
  activity: SwarmUiActivity[]
  models: SwarmUiModel[]
  workers: SwarmUiWorker[]
  resources: SwarmUiResource[]
  metrics: SwarmUiMetrics
  counts: SwarmUiCounts
  primarySummary: SwarmUiPrimarySummary
  queue: { agentID: string; queuedAt: number; reason: string }[]
}

export interface SwarmUiViewState {
  // Hierarchy tree: which agent ids are expanded.
  expanded: ReadonlySet<string>
  // Current tree filter (matches agent id / role / state / model / mission).
  filter: string
  stateFilter: "all" | SwarmAgent.State
  modelFilter: string
  // Flat-list pagination.
  page: number
  pageSize: number
  // Selected agent id (drives the agent detail pane).
  selectedAgentID?: string
  selectedTaskID?: string
  selectedApprovalID?: string
  selectedArtifactID?: string
}

export function emptyViewState(): SwarmUiViewState {
  return {
    expanded: new Set<string>(),
    filter: "",
    stateFilter: "all",
    modelFilter: "",
    page: 0,
    pageSize: 40,
  }
}
