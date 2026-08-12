export * as SwarmDedup from "./dedup"

import { Schema } from "effect"
import { ascending } from "@opencode-ai/schema/identifier"
import { optional, DateTimeUtcFromMillis, statics } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"

// OSS-style finding identifier so references survive simulation reboots.
export const FindingID = Schema.String.check(Schema.isStartsWith("OSW-")).pipe(
  Schema.brand("SwarmDedup.Finding.ID"),
  statics((schema) => ({ create: () => schema.make("OSW-" + ascending().slice(0, 6)) })),
)
export type FindingID = typeof FindingID.Type

export const Severity = Schema.Literals(["info", "low", "medium", "high", "blocker"]).annotate({
  identifier: "SwarmDedup.Severity",
})
export type Severity = typeof Severity.Type

export interface Report extends Schema.Schema.Type<typeof Report> {}
export const Report = Schema.Struct({
  // Free-form title the agent emitted. Used to compute the fingerprint hash.
  title: Schema.String,
  // Optional area path the finding applies to, e.g. "packages/llm/parser".
  area: optional(Schema.String),
  // Optional file or symbol the reporter pinned.
  location: optional(Schema.String),
  severity: Severity,
  reporter: SwarmAgent.ID,
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "SwarmDedup.Report" })

export interface Cluster extends Schema.Schema.Type<typeof Cluster> {}
export const Cluster = Schema.Struct({
  id: FindingID,
  title: Schema.String,
  area: optional(Schema.String),
  severity: Severity,
  reporters: Schema.Array(SwarmAgent.ID),
  reportCount: Schema.Int,
  firstSeen: DateTimeUtcFromMillis,
  lastSeen: DateTimeUtcFromMillis,
}).annotate({ identifier: "SwarmDedup.Cluster" })

// ---------------------------------------------------------------------------
// Fingerprinting. Reports that probe the same conceptual defect must cluster
// together even when their prose differs. We use a normalize-then-hash of
// title tokens plus area+location. Provenance (all reporter ids) is preserved.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "in", "of", "on", "at", "to", "is", "are", "and", "or", "for", "with", "by",
  "crash", "crashes", "crashed", "broken", "breaks", "broken", "fails", "fail", "fail.", "failed",
  "issue", "issues", "problem", "problems", "bug", "bugs",
])

export function normalizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9_/.-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .sort()
}

export function fingerprint(report: { title: string; area?: string; location?: string }): string {
  const toks = normalizeTitle(report.title)
  const area = (report.area ?? "").toLowerCase().trim()
  const loc = (report.location ?? "").toLowerCase().trim()
  return [toks.join("|"), `area:${area}`, `loc:${loc}`].join(";")
}

// Stable string-hash (FNV-1a 32) — same input always hashes to the same 32-bit
// int. Good enough for clustering; we are NOT relying on this for security.
export function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const severityRank: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, blocker: 4 }

export function worseSeverity(a: Severity, b: Severity): Severity {
  return severityRank[a] >= severityRank[b] ? a : b
}

// ---------------------------------------------------------------------------
// Clustering engine — pure & deterministic. Reports with identical
// fingerprints join the same canonical finding. Reporter provenance is kept
// ordered by arrival so the audit log is replayable.
// ---------------------------------------------------------------------------

export interface ClusteringState {
  // fingerprint -> canonicalCluster
  readonly byFingerprint: Map<string, Cluster>
  // canonical ID -> fingerprint (for redundant reverse lookup during query)
  readonly byClusterID: Map<string, string>
}

export function emptyClusteringState(): ClusteringState {
  return { byFingerprint: new Map(), byClusterID: new Map() }
}

export type ClusterOutcome = { kind: "new"; cluster: Cluster } | { kind: "merged"; cluster: Cluster }

export function clusterReport(state: ClusteringState, report: Report): ClusterOutcome {
  const fp = fingerprint(report)
  const existing = state.byFingerprint.get(fp)
  if (existing) {
    const merged: Cluster = {
      ...existing,
      severity: worseSeverity(existing.severity, report.severity),
      reporters: dedupAppend(existing.reporters, report.reporter),
      reportCount: existing.reportCount + 1,
      lastSeen: report.time,
    }
    state.byFingerprint.set(fp, merged)
    return { kind: "merged", cluster: merged }
  }
  const cluster: Cluster = {
    id: FindingID.create(),
    title: report.title,
    area: report.area,
    severity: report.severity,
    reporters: [report.reporter],
    reportCount: 1,
    firstSeen: report.time,
    lastSeen: report.time,
  }
  state.byFingerprint.set(fp, cluster)
  state.byClusterID.set(cluster.id, fp)
  return { kind: "new", cluster }
}

export function dedupAppend(items: ReadonlyArray<SwarmAgent.ID>, item: SwarmAgent.ID): SwarmAgent.ID[] {
  if (items.includes(item)) return [...items]
  return [...items, item]
}

export function listClusters(state: ClusteringState, area?: string): Cluster[] {
  const out = [...state.byFingerprint.values()]
  if (area !== undefined) return out.filter((c) => c.area === area)
  return out.sort((a, b) => severityRank[b.severity] - severityRank[a.severity])
}

export function clusterCount(state: ClusteringState): number {
  return state.byFingerprint.size
}