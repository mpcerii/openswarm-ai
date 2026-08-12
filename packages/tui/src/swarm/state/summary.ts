import type { SwarmUiApproval, SwarmUiArtifact, SwarmUiCounts, SwarmUiMission, SwarmUiPrimarySummary, SwarmUiResource } from "./types"

// ---------------------------------------------------------------------------
// Concise primary-agent operational summary. A few lines a human can read at a
// glance without the primary spamming the chat: confirmed findings, fixes
// ready for integration, approvals that need the human, budget pressure.
// ---------------------------------------------------------------------------

export interface SummaryInput {
  counts: SwarmUiCounts
  approvals: ReadonlyArray<SwarmUiApproval>
  resources: ReadonlyArray<SwarmUiResource>
  missions: ReadonlyArray<SwarmUiMission>
  artifacts: ReadonlyArray<SwarmUiArtifact>
  findings: number
}

export function primarySummary(input: SummaryInput): SwarmUiPrimarySummary {
  const { counts, approvals, resources, missions, artifacts, findings } = input
  const fixesReady = artifacts.filter((a) => a.state === "proposed" || a.state === "reviewed" || a.state === "approved").length
  const approvalsNeeded = approvals.length
  const highApprovals = approvals.filter((a) => a.severity === "HIGH").length
  const pendingBudget = approvals.filter((a) => a.action === "budget_increase").length
  const budget = resources[0]
  const budgetRatio = budget !== undefined ? Math.round(budget.tokenBudget.ratio * 100) : 0
  const threshold = budget?.threshold ?? "ok"

  const lines: string[] = []
  lines.push(`Swarm: ${counts.running} active, ${counts.queued} queued, ${counts.completed} done, ${counts.failed} failed`)
  if (findings > 0) lines.push(`${findings} finding${findings === 1 ? "" : "s"} clustered`)
  lines.push(`${fixesReady} fix${fixesReady === 1 ? "" : "s"} ready for integration`)
  if (approvalsNeeded > 0) {
    lines.push(`${approvalsNeeded} approval${approvalsNeeded === 1 ? "" : "s"} needed (${highApprovals} high)`)
  } else {
    lines.push("no approvals pending")
  }
  if (pendingBudget > 0) lines.push(`${pendingBudget} budget increase request${pendingBudget === 1 ? "" : "s"}`)
  if (missions.length > 0) {
    const title = missions[0]!.title
    const author = missions[0]!.author
    lines.push(`Mission "${title}" (by ${author}) — budget at ${budgetRatio}%${threshold === "hard" ? " (HARD STOP)" : threshold === "soft" ? " (soft threshold)" : ""}`)
  }
  return {
    lines,
    bugsConfirmed: findings,
    fixesReady,
    approvalsNeeded,
    pendingBudget,
  }
}
