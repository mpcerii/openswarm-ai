import { SwarmAudit } from "@opencode-ai/swarm/audit/audit"
import type { AlertSeverity, SwarmUiActivity } from "./types"

// ---------------------------------------------------------------------------
// Structured activity feed. The audit log is the attribution backbone, but the
// TUI should NOT surface raw internal model chatter by default. This curated
// projection keeps only human-relevant transitions (findings, patches,
// reviews, approvals, budgets, worker/model health, failures) and classifies
// each with an alert severity.
// ---------------------------------------------------------------------------

interface Rule {
  severity: AlertSeverity
  title: (d: Record<string, unknown>) => string
  detail?: (d: Record<string, unknown>) => string | undefined
  agentKey?: string
  missionKey?: string
  taskKey?: string
  artifactKey?: string
}

function pick(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  if (value === undefined) return undefined
  return typeof value === "string" ? value : JSON.stringify(value)
}

function s(data: Record<string, unknown>): Record<string, unknown> {
  return data as Record<string, unknown>
}

const RULES: Readonly<Record<string, Rule>> = Object.freeze({
  "swarm.finding.clustered": {
    severity: "info",
    title: (d) => `Finding clustered: ${String(d.canonicalTitle ?? "untitled")}`,
    detail: (d) => `${Array.isArray(d.reporters) ? d.reporters.length : 0} reporter(s)`,
  },
  "swarm.artifact.created": {
    severity: "info",
    title: (d) => `${String(d.kind ?? "artifact")} created`,
    detail: (d) => (d.artifactID !== undefined ? `ref ${String(d.ref ?? "")}` : undefined),
    agentKey: "agentID",
    artifactKey: "artifactID",
  },
  "swarm.review.created": {
    severity: "info",
    title: (d) => `Review ${String(d.verdict ?? "completed")}`,
    detail: (d) => `objective ${String(d.objective ?? "")}`,
    agentKey: "reviewerAgentID",
    artifactKey: "artifactID",
  },
  "swarm.approval.requested": {
    severity: "high",
    title: () => "Approval requested",
    detail: (d) => {
      const req = d.request as Record<string, unknown> | undefined
      return req !== undefined ? `${String(req.action ?? "")}: ${String(req.summary ?? "")}` : undefined
    },
    agentKey: "agentID",
  },
  "swarm.tool.requested_approval": {
    severity: "high",
    title: (d) => `Approval requested for ${String(d.tool ?? "")}`,
    agentKey: "agentID",
  },
  "swarm.integration.proposed": {
    severity: "high",
    title: () => "Integration proposed",
    detail: (d) => `${String(d.changedFiles ?? 0)} file(s), ${String(d.testsAdded ?? 0)} tests`,
    missionKey: "missionID",
  },
  "swarm.budget.warned": {
    severity: "warning",
    title: () => "Mission budget at soft threshold",
    detail: (d) => `${String(d.used_calls ?? 0)} calls / ${String(d.used_tokens ?? 0)} tokens`,
    missionKey: "missionID",
  },
  "swarm.budget.hard_reached": {
    severity: "high",
    title: () => "Mission budget exhausted (hard stop)",
    detail: (d) => `${String(d.used_calls ?? 0)} calls / ${String(d.used_tokens ?? 0)} tokens`,
    missionKey: "missionID",
  },
  "swarm.budget.increase_requested": {
    severity: "warning",
    title: () => "Budget increase requested",
    detail: (d) => String(d.reason ?? ""),
    agentKey: "agentID",
    missionKey: "missionID",
  },
  "swarm.worker.registered": {
    severity: "info",
    title: (d) => `Worker registered: ${String(d.name ?? d.workerID ?? "")}`,
    missionKey: undefined,
  },
  "swarm.worker.offline": {
    severity: "warning",
    title: (d) => `Worker offline: ${String(d.workerID ?? "")}`,
    detail: (d) => String(d.reason ?? ""),
  },
  "swarm.worker.draining": {
    severity: "warning",
    title: (d) => `Worker draining: ${String(d.workerID ?? "")}`,
  },
  "swarm.lease.expired": {
    severity: "warning",
    title: (d) => `Lease expired for ${String(d.agentID ?? "")}`,
    agentKey: "agentID",
  },
  "swarm.agent.failed": {
    severity: "warning",
    title: (d) => `Agent failed: ${String(d.agentID ?? "")}`,
    detail: (d) => String(d.error ?? ""),
    agentKey: "agentID",
  },
  "swarm.model.health_changed": {
    severity: "warning",
    title: (d) => `Model health: ${String(d.model ?? "")} → ${String(d.health ?? "")}`,
  },
  "swarm.agent.completed": {
    severity: "info",
    title: (d) => `Agent completed: ${String(d.agentID ?? "")}`,
    agentKey: "agentID",
  },
  "swarm.task.created": {
    severity: "info",
    title: (d) => `Task: ${String(d.title ?? "")}`,
    taskKey: "taskID",
  },
  "swarm.task.completed": {
    severity: "info",
    title: (d) => `Task completed: ${String(d.taskID ?? "")}`,
    taskKey: "taskID",
  },
  "swarm.integration.approved": {
    severity: "high",
    title: (d) => `Integration approved by ${String(d.approver ?? "human")}`,
    missionKey: "missionID",
  },
  "swarm.integration.rejected": {
    severity: "high",
    title: () => "Integration rejected",
    missionKey: "missionID",
  },
  "swarm.budget.limits_changed": {
    severity: "info",
    title: () => "Mission budget limits changed by human",
    missionKey: "missionID",
  },
  "swarm.budget.active_bound_changed": {
    severity: "info",
    title: (d) => `Active bound changed to ${String(d.max_active_agents ?? "")}`,
  },
  "swarm.agent.cancelled": {
    severity: "info",
    title: (d) => `Agent cancelled: ${String(d.agentID ?? "")}`,
    agentKey: "agentID",
  },
  "swarm.emergency.stopped": {
    severity: "critical",
    title: () => "EMERGENCY STOP engaged",
    detail: (d) => `${String(d.population ?? 0)} agents preserved; scheduling halted`,
  },
  "swarm.emergency.resumed": {
    severity: "high",
    title: () => "Emergency stop released; scheduling resumed",
  },
  "swarm.model.disabled": {
    severity: "warning",
    title: (d) => `Model disabled by human: ${String(d.model ?? "")}`,
  },
  "swarm.model.enabled": {
    severity: "info",
    title: (d) => `Model enabled by human: ${String(d.model ?? "")}`,
  },
})

// Which audit event types surface in the human activity feed.
export const HUMAN_ACTIVITY_TYPES: readonly string[] = Object.keys(RULES)

function classify(entry: SwarmAudit.StoredEvent, index: number): SwarmUiActivity | undefined {
  const rule = RULES[entry.type]
  if (rule === undefined) return undefined
  const data = s(entry.data as Record<string, unknown>)
  return {
    id: index,
    type: entry.type,
    time: entry.time,
    agentID: rule.agentKey !== undefined ? pick(data, rule.agentKey) : undefined,
    missionID: rule.missionKey !== undefined ? pick(data, rule.missionKey) : undefined,
    taskID: rule.taskKey !== undefined ? pick(data, rule.taskKey) : undefined,
    artifactID: rule.artifactKey !== undefined ? pick(data, rule.artifactKey) : undefined,
    title: rule.title(data),
    detail: rule.detail?.(data),
    severity: rule.severity,
  }
}

export function activityFeed(log: SwarmAudit.AuditLog, opts: { limit?: number; now?: number } = {}): SwarmUiActivity[] {
  const limit = opts.limit ?? 200
  const out: SwarmUiActivity[] = []
  // Newest first: walk the append-only log backwards, keep curated entries.
  for (let index = log.events.length - 1; index >= 0; index--) {
    if (out.length >= limit) break
    const entry = log.events[index]
    if (entry === undefined) continue
    if (RULES[entry.type] === undefined) continue
    const item = classify(entry, index)
    if (item === undefined) continue
    out.push(item)
  }
  return out
}
