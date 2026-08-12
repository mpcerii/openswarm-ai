import { SwarmApproval } from "@opencode-ai/swarm/approvals/approval"
import type { SwarmUiApproval, ApprovalSeverity, SwarmUiArtifact } from "./types"
import { DateTimeMillis } from "./snapshot"

// ---------------------------------------------------------------------------
// Approval inbox + integration review aggregation. Pure projections: severity
// classification is fixed here (never LLM-derived) and integration reviews are
// computed from the artifact ledger so the human sees one consolidated view.
// ---------------------------------------------------------------------------

// Severity drives sort order and the inbox badge. HIGH = the human should
// decide soon (external effect, budget, integration, destructive ops).
export function approvalSeverity(action: SwarmApproval.Action, risk: string): ApprovalSeverity {
  if (action === "merge" || action === "integration" || action === "budget_increase") return "HIGH"
  if (action === "external_side_effect" || action === "git_push" || risk === "R4_critical" || risk === "R3_external") {
    return "HIGH"
  }
  if (action === "dependency_change" || action === "git_commit") return "MEDIUM"
  return "LOW"
}

export function approvalRiskLabel(risk: string): string {
  return risk.replace(/^R([0-4])_(.+)$/, "R$1 $2")
}

export function approvalUi(request: SwarmApproval.Request, mission: string): SwarmUiApproval {
  const action = request.action
  const risk = request.metadata?.risk !== undefined ? String(request.metadata.risk) : SwarmApproval.riskOf(action)
  const resource = request.metadata?.resource !== undefined ? String(request.metadata.resource) : undefined
  const budgetReason = request.metadata?.reason !== undefined ? String(request.metadata.reason) : undefined
  const budgetUsedCalls = request.metadata?.used_calls !== undefined ? Number(request.metadata.used_calls) : undefined
  const budgetUsedTokens = request.metadata?.used_tokens !== undefined ? Number(request.metadata.used_tokens) : undefined
  return {
    id: request.id,
    agentID: request.agentID,
    action,
    summary: request.summary,
    resource,
    risk,
    mission,
    time: DateTimeMillis(request.time),
    severity: approvalSeverity(action, risk),
    budgetReason,
    budgetUsedCalls,
    budgetUsedTokens,
  }
}

export type IntegrationPatchStat = {
  artifactID: string
  summary?: string
  files: number
  tests: number
  testsFailed: number
  verdicts: string[]
  approved: boolean
}

export interface IntegrationReview {
  missionID: string
  title: string
  patchCount: number
  filesChanged: number
  files: string[]
  testsTotal: number
  testsFailed: number
  reviewCount: number
  verdicts: Record<string, number>
  conflicts: boolean
  risk: string
  patches: IntegrationPatchStat[]
  ready: boolean
}

// Consolidated view shown before approving a large change: aggregates every
// proposed/reviewed/approved artifact of a mission into one reviewable unit.
export function integrationReview(
  artifacts: ReadonlyArray<SwarmUiArtifact>,
  mission: { id: string; title: string },
  now: number,
): IntegrationReview {
  void now
  const candidates = artifacts.filter((a) => a.state === "proposed" || a.state === "reviewed" || a.state === "approved")
  const files = [...new Set(candidates.flatMap((a) => a.changedFiles))].toSorted()
  const verdicts: Record<string, number> = {}
  let reviewCount = 0
  let testsTotal = 0
  let testsFailed = 0
  const patches: IntegrationPatchStat[] = candidates.map((a) => {
    for (const v of a.reviews.map((r) => r.verdict)) verdicts[v] = (verdicts[v] ?? 0) + 1
    reviewCount += a.reviews.length
    testsTotal += a.testsExecuted.length
    const failed = a.testResults.filter((r) => r === "fail").length
    testsFailed += failed
    const approved = a.reviews.length > 0 && a.reviews.every((r) => r.verdict === "accept")
    return {
      artifactID: a.id,
      summary: a.summary,
      files: a.changedFiles.length,
      tests: a.testsExecuted.length,
      testsFailed: failed,
      verdicts: [...new Set(a.reviews.map((r) => r.verdict))],
      approved,
    }
  })
  const risk = candidates.some((a) => a.changedFiles.some((f) => f.includes("package.json") || f.includes("lockfile")))
    ? "R2 dependency / project change"
    : "R2 project change"
  return {
    missionID: mission.id,
    title: mission.title,
    patchCount: candidates.length,
    filesChanged: files.length,
    files,
    testsTotal,
    testsFailed,
    reviewCount,
    verdicts,
    conflicts: candidates.some((a) => a.state === "reviewed" && a.reviews.some((r) => r.verdict === "reject")),
    risk,
    patches,
    ready: candidates.length > 0,
  }
}

export function sortApprovals(a: SwarmUiApproval[]): SwarmUiApproval[] {
  const rank: Record<ApprovalSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }
  return [...a].sort((x, y) => rank[x.severity] - rank[y.severity] || y.time - x.time)
}
