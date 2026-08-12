export * as SwarmReview from "./review"

import { Schema } from "effect"
import { ascending } from "@opencode-ai/schema/identifier"
import { optional, DateTimeUtcFromMillis, statics, NonNegativeInt } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"
import { SwarmArtifact } from "../artifacts/artifact"

export const ID = Schema.String.check(Schema.isStartsWith("swr_")).pipe(
  Schema.brand("SwarmReview.ID"),
  statics((schema) => ({ create: () => schema.make("swr_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Verdict = Schema.Literals(["accept", "changes_requested", "reject"]).annotate({
  identifier: "SwarmReview.Verdict",
})
export type Verdict = typeof Verdict.Type

// A reviewer objective identifies the bias the reviewer is asked to bring.
// "adversarial" reviewers are explicitly told to assume the patch is wrong
// and find a concrete failure mode. The kernel may mix objective types when
// building a review swarm for a single artifact.
export const Objective = Schema.Literals([
  "correctness",
  "regression",
  "security",
  "tests",
  "architecture",
  "performance",
  "api_compatibility",
  "adversarial",
  "read_only_inspection",
]).annotate({ identifier: "SwarmReview.Objective" })
export type Objective = typeof Objective.Type

export const Severity = Schema.Literals(["info", "low", "medium", "high", "blocker"]).annotate({
  identifier: "SwarmReview.Severity",
})
export type Severity = typeof Severity.Type

export interface Finding extends Schema.Schema.Type<typeof Finding> {}
export const Finding = Schema.Struct({
  severity: Severity,
  message: Schema.String,
  location: optional(Schema.String),
}).annotate({ identifier: "SwarmReview.Finding" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  reviewerAgentID: SwarmAgent.ID,
  artifactID: SwarmArtifact.ID,
  objective: Objective,
  verdict: Verdict,
  findings: Schema.Array(Finding),
  // 0..100 self-reported. Confidence alone is NEVER sufficient for
  // integration: the kernel accepts only on `verdict: "accept"` AND the absence
  // of high-severity/blocker findings, regardless of confidence.
  confidence: NonNegativeInt,
  // Adversarial reviewers SHOULD record the concrete failure path they
  // hypothesised even when they could not prove it; absence keeps the field
  // optional for non-adversarial reviewers.
  hypothesis: optional(Schema.String),
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "SwarmReview.Info" })

// Integer gate. The kernel uses this to decide whether a patch is "review
// passed" given a swarm of reviews for the same artifact. A single "reject"
// always blocks; a single high-severity/blocker finding blocks integration;
// confidence is informational.
export function isAcceptable(reviews: ReadonlyArray<Info>): { ok: boolean; reason?: string } {
  if (reviews.length === 0) return { ok: false, reason: "no reviews" }
  for (const r of reviews) {
    if (r.verdict === "reject") return { ok: false, reason: `reviewer ${r.reviewerAgentID} rejected` }
    for (const f of r.findings) {
      if (f.severity === "blocker") return { ok: false, reason: `blocker: ${f.message}` }
      if (f.severity === "high") return { ok: false, reason: `high-severity: ${f.message}` }
    }
  }
  const accepted = reviews.filter((r) => r.verdict === "accept")
  if (accepted.length < Math.ceil(reviews.length / 2)) {
    return { ok: false, reason: `majority not accept (${accepted.length}/${reviews.length})` }
  }
  return { ok: true }
}