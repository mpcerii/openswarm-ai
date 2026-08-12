export * as SwarmProvenance from "./provenance"

import { SwarmAgent } from "../agent/agent"
import { SwarmTask } from "../task/task"
import { SwarmArtifact } from "../artifacts/artifact"
import { SwarmReview } from "../review/review"

// /why chain. Reconstructs the full attribution line from a file/change to
// the original human mission. The chain lives in durable audit history; this
// helper is pure given a materialized view of the relationships.
export interface Chain {
  mission: string
  missionAuthor: string
  task?: SwarmTask.Info
  implementerAgent?: SwarmAgent.Info
  artifacts: SwarmArtifact.Info[]
  reviews: SwarmReview.Info[]
  approved: boolean
  integrated: boolean
}

export interface ProvenanceView {
  // Map artifact id -> reviews, joined at lookup time from the audit log.
  readonly reviewsByArtifact: ReadonlyMap<string, SwarmReview.Info[]>
  // Map file path -> artifact ids touching that file (a single file may be in
  // many candidate patches before reconciliation).
  readonly artifactsByFile: ReadonlyMap<string, SwarmArtifact.Info[]>
  // Map task -> implementer agent.
  readonly agentByTask: ReadonlyMap<string, SwarmAgent.Info>
  // Map task id -> task info.
  readonly taskByID: ReadonlyMap<string, SwarmTask.Info>
  // Map mission -> author (human identifier).
  readonly missionAuthor: ReadonlyMap<string, string>
  // Set of artifact ids the human approved for integration.
  readonly approvedArtifacts: ReadonlySet<string>
  readonly integratedArtifacts: ReadonlySet<string>
}

export function buildChain(view: ProvenanceView, file: string, missionID: string): Chain {
  const artifacts = view.artifactsByFile.get(file) ?? []
  const reviews = artifacts.flatMap((a) => view.reviewsByArtifact.get(a.id) ?? [])
  const chain: Chain = {
    mission: missionID,
    missionAuthor: view.missionAuthor.get(missionID) ?? "human",
    artifacts,
    reviews,
    approved: artifacts.every((a) => view.approvedArtifacts.has(a.id)),
    integrated: artifacts.every((a) => view.integratedArtifacts.has(a.id)),
  }
  const taskID = artifacts[0]?.taskID
  if (taskID !== undefined) {
    const task = view.taskByID.get(taskID)
    if (task) chain.task = task
    const agentRecord = view.agentByTask.get(taskID)
    if (agentRecord) chain.implementerAgent = agentRecord
  }
  return chain
}

// Render the chain for /why as a compact, monotonic string suitable for
// TUI display. Pure — no IO. Sensitive metadata is dropped intentionally
// (the audit log already redacts values when storing requests).
export function renderChain(chain: Chain, file: string): string {
  const lines: string[] = []
  lines.push(`/why ${file}`)
  lines.push(`  mission: ${chain.mission} (by ${chain.missionAuthor})`)
  if (chain.task) lines.push(`  task: ${chain.task.id} — ${chain.task.title}`)
  if (chain.implementerAgent) {
    lines.push(`  implementer: ${chain.implementerAgent.id} (${chain.implementerAgent.state})`)
  }
  for (const a of chain.artifacts) {
    lines.push(`  artifact: ${a.id} kind=${a.kind} ref=${a.ref}`)
  }
  for (const r of chain.reviews) {
    lines.push(`  review: ${r.id} verdict=${r.verdict} objective=${r.objective} confidence=${r.confidence}`)
  }
  lines.push(`  approved=${chain.approved} integrated=${chain.integrated}`)
  return lines.join("\n")
}