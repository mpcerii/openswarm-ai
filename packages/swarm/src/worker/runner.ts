export * as SwarmWorkerRunner from "./runner"

import { DateTime } from "effect"
import { SwarmAgent } from "../agent/agent"
import { SwarmMessage } from "../messaging/message"
import { SwarmArtifact } from "../artifacts/artifact"
import { SwarmCensus } from "../census/census"
import { SwarmApproval } from "../approvals/approval"
import { SwarmDedup } from "../dedup/dedup"
import { SwarmProvider } from "../provider/provider"
import { SwarmIdempotency } from "../cluster/idempotency"
import { SwarmCredentials } from "../cluster/credentials"
import type { ControlPlaneApi } from "../cluster/transport"
import type { MissionRecord } from "../storage/store"

// ---------------------------------------------------------------------------
// Agent runner: executes ONE agent run on a worker. Reuses the pure decision
// modules (approvals, dedup, artifact building) exactly like the monolithic
// runtime, but all durable writes go through the control plane, and every
// side effect is idempotent so a retried run cannot duplicate work.
// ---------------------------------------------------------------------------

// Fixed mapping from tool names to Approval.Action vocabulary. Never derived
// from LLM output; the runner's tool dispatch is the only authority.
const ACTION_BY_TOOL: Readonly<Record<string, SwarmApproval.Action>> = Object.freeze({
  dependency_change: "dependency_change",
  git_commit: "git_commit",
  git_push: "git_push",
  merge: "merge",
  external_side_effect: "external_side_effect",
  run_bash: "external_side_effect",
  edit_file: "external_side_effect",
})

export interface RunParams {
  readonly agent: SwarmAgent.AgentRecord
  readonly mission?: MissionRecord
  readonly census?: SwarmCensus.Info
  readonly inbox: SwarmMessage.Info[]
  readonly provider: SwarmProvider.Provider
  readonly api: ControlPlaneApi
  readonly now: () => number
}

export interface RunResult {
  readonly state: "completed" | "awaiting_approval"
  readonly requestID?: string
  readonly artifacts: string[]
  readonly findings: string[]
  readonly tokens: number
}

export async function runAgent(p: RunParams): Promise<RunResult> {
  let tokens = 0
  let pendingApproval: SwarmApproval.Request | undefined
  const stream = p.provider.stream({
    agentID: p.agent.id,
    model: p.agent.resolvedModel ?? "unknown",
    role: p.agent.role,
    systemPrompt: systemPromptFor(p.agent, p.mission),
    userText: userTextFor(p.inbox),
    permittedFiles: permittedFilesFor(p.census, p.agent),
    missionID: p.agent.mission,
    parentAgentID: p.agent.parent?.agentID,
  })
  const artifacts: string[] = []
  const findings: string[] = []
  for await (const chunk of stream) {
    if (chunk.error) throw new Error(chunk.error)
    if (chunk.tokens !== undefined) tokens += chunk.tokens
    if (chunk.toolCalls !== undefined) {
      for (const call of chunk.toolCalls) {
        const stop = await handleTool(p, call, artifacts, findings)
        if (stop !== undefined) {
          pendingApproval = stop
          break
        }
      }
    }
    if (pendingApproval !== undefined) break
    if (chunk.finish !== undefined && chunk.finish !== "paused") break
  }
  if (pendingApproval !== undefined) {
    return { state: "awaiting_approval", requestID: pendingApproval.id, artifacts, findings, tokens }
  }
  return { state: "completed", artifacts, findings, tokens }
}

async function handleTool(p: RunParams, call: SwarmProvider.ToolCall, artifacts: string[], findings: string[]): Promise<SwarmApproval.Request | undefined> {
  const agentID = p.agent.id
  await p.api.emitAudit("swarm.tool.requested", { agentID, tool: call.tool, args: call.args }, p.now())
  switch (call.tool) {
    case "register_finding": {
      const report: SwarmDedup.Report = {
        title: String(call.args.title ?? "untitled finding"),
        area: call.args.area !== undefined ? String(call.args.area) : undefined,
        location: call.args.location !== undefined ? String(call.args.location) : undefined,
        severity: (call.args.severity as SwarmDedup.Severity) ?? "medium",
        reporter: agentID,
        time: DateTime.makeUnsafe(p.now()),
      }
      const out = await p.api.clusterFinding(agentID, report)
      findings.push(out.findingID)
      return undefined
    }
    case "write_patch": {
      const patch = buildPatch(agentID, call.args)
      const key = SwarmIdempotency.artifactKey(agentID, contentRef(patch))
      const artifact = await p.api.createArtifact(agentID, key, patch, p.now())
      artifacts.push(artifact.artifact.id)
      return undefined
    }
    case "request_review":
    case "propose_integration":
      // Review swarms and integration proposals are composed by the control
      // plane in a later milestone; the worker records the intent today.
      await p.api.emitAudit(`swarm.tool.${call.tool}`, { agentID }, p.now())
      return undefined
    default: {
      const action = ACTION_BY_TOOL[call.tool]
      if (action === undefined) {
        await p.api.emitAudit("swarm.tool.denied", { agentID, tool: call.tool, reason: "unknown tool" }, p.now())
        return undefined
      }
      const resource = String(call.args.target ?? call.args.path ?? "any")
      return p.api.requestApproval(agentID, action, resource, `${call.tool} on ${resource}`, p.now())
    }
  }
}

function systemPromptFor(agent: SwarmAgent.AgentRecord, mission: MissionRecord | undefined): string {
  return [
    `You are a swarm agent (role=${agent.role ?? "general"}, depth=${agent.depth}, model=${agent.resolvedModel ?? "unknown"}).`,
    `Mission: ${mission?.title ?? agent.mission}`,
    `Brief: ${mission?.brief ?? ""}`,
    `Allowed tools: register_finding, write_patch, request_review, propose_integration. High-risk: dependency_change, git_commit, git_push, merge, external_side_effect.`,
  ].join("\n")
}

function userTextFor(inbox: SwarmMessage.Info[]): string {
  if (inbox.length === 0) return "Continue the mission."
  return inbox.map((m) => `[${m.from}]: ${m.body}`).join("\n")
}

function permittedFilesFor(census: SwarmCensus.Info | undefined, agent: SwarmAgent.AgentRecord): readonly string[] {
  if (census === undefined) return []
  if (agent.role?.startsWith("reviewer") || agent.role === "investigator") return []
  return census.modules.map((m) => m.path)
}

function buildPatch(agentID: SwarmAgent.ID, args: Record<string, unknown>): SwarmArtifact.PatchBody {
  return {
    baseCommit: String(args.baseCommit ?? "HEAD"),
    changedFiles: Array.isArray(args.changedFiles) ? (args.changedFiles as string[]) : [],
    diff: String(args.diff ?? ""),
    testsExecuted: Array.isArray(args.tests) ? (args.tests as string[]) : [],
    testResults: (args.testResults ?? ["pass"]) as unknown as ("pass" | "fail" | "skipped")[],
    reason: String(args.reason ?? "implementer emitted patch"),
    tokensUsed: 0,
  }
}

// Stable content fingerprint so retrying the same patch is deduplicated by the
// control plane's idempotency ledger.
function contentRef(patch: SwarmArtifact.PatchBody): string {
  return SwarmCredentials.sha256(`${patch.diff}|${patch.changedFiles.join(",")}`)
}
