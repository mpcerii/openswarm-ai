export * as SwarmConflict from "./conflict"

import { Schema, DateTime } from "effect"
import { ascending } from "@opencode-ai/schema/identifier"
import { optional, DateTimeUtcFromMillis, statics } from "@opencode-ai/schema/schema"
import { SwarmAgent } from "../agent/agent"

export const LeaseID = Schema.String.check(Schema.isStartsWith("swe_")).pipe(
  Schema.brand("SwarmConflict.Lease.ID"),
  statics((schema) => ({ create: () => schema.make("swe_" + ascending()) })),
)
export type LeaseID = typeof LeaseID.Type

// An area is a glob-style tree path like "packages/runtime/**" or a single
// exact file "packages/runtime/index.ts". Two leases conflict if their areas
// overlap; the manager rejects the second with a structured error so the
// scheduler can route the agent elsewhere or queue it.
export interface Area extends Schema.Schema.Type<typeof Area> {}
export const Area = Schema.Struct({
  pattern: Schema.String,
  // "exclusive_write" blocks any other write lease on overlapping areas.
  // "shared_write" allows parallelism between writers that explicitly opted
  // in (e.g. test-only agents on adjacent code). Write-readers never need a
  // lease; read-only agents acquire none.
  mode: Schema.Literals(["exclusive_write", "shared_write"]),
}).annotate({ identifier: "SwarmConflict.Area" })

export interface Lease extends Schema.Schema.Type<typeof Lease> {}
export const Lease = Schema.Struct({
  id: LeaseID,
  agentID: SwarmAgent.ID,
  area: Area,
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "SwarmConflict.Lease" })

// Overlap test. Returns true if the two glob-ish patterns can touch the same
// resource. Patterns are matched under `patternMatches`-compatible rules.
// Pure & deterministic.
export function areasOverlap(a: string, b: string): boolean {
  if (a === b) return true
  if (a === "*" || b === "*") return true
  // "**" suffix matches any descendant — overlap if one prefix contains the
  // other's base.
  const bases = (p: string) =>
    p.endsWith("/**")
      ? [p.slice(0, -3)]
      : p.endsWith("/*")
        ? [p.slice(0, -2)]
        : p.endsWith("*")
          ? [p.slice(0, -1)]
          : [p]
  const ba = bases(a)
  const bb = bases(b)
  for (const x of ba) for (const y of bb) {
    if (x === y) return true
    if (x.startsWith(y + "/") || y.startsWith(x + "/")) return true
    if (x === "" || y === "") return true // root
  }
  return false
}

export interface LeaseManager {
  // Owned leases keyed by lease id; mirrors the in-process ledger. Pure-ish:
  // mutated only through acquire/release so the kernel keeps ordered access.
  readonly active: Map<string, Lease>
}

export function emptyLeaseManager(): LeaseManager {
  return { active: new Map() }
}

export type AcquireResult =
  | { ok: true; lease: Lease }
  | { ok: false; reason: "conflict"; conflictingAgent: SwarmAgent.ID; blockingLease: LeaseID }

export function acquireLease(
  manager: LeaseManager,
  agentID: SwarmAgent.ID,
  area: Area,
  now: number,
): AcquireResult {
  for (const existing of manager.active.values()) {
    const bothWriteShared = area.mode === "shared_write" && existing.area.mode === "shared_write"
    if (bothWriteShared && areasOverlap(area.pattern, existing.area.pattern)) {
      // Allowed in parallel only when they target *exactly* the same area
      // (common case: test-only agents on the same test dir).
      if (area.pattern !== existing.area.pattern) {
        return { ok: false, reason: "conflict", conflictingAgent: existing.agentID, blockingLease: existing.id }
      }
      continue
    }
    if (areasOverlap(area.pattern, existing.area.pattern)) {
      return { ok: false, reason: "conflict", conflictingAgent: existing.agentID, blockingLease: existing.id }
    }
  }
  const lease: Lease = { id: LeaseID.create(), agentID, area, time: DateTime.makeUnsafe(now) }
  manager.active.set(lease.id, lease)
  return { ok: true, lease }
}

export function releaseLease(manager: LeaseManager, leaseID: LeaseID): void {
  manager.active.delete(leaseID)
}

export function releaseAllForAgent(manager: LeaseManager, agentID: SwarmAgent.ID): number {
  let n = 0
  for (const [id, l] of manager.active) {
    if (l.agentID === agentID) {
      manager.active.delete(id)
      n++
    }
  }
  return n
}

// Merge prediction. Given a list of patch artifacts (each touching file sets),
// detect pairwise overlap that would risk a non-trivial merge. Pure.
export interface PatchFiles {
  readonly id: string
  readonly files: string[]
}
export type MergePair = { a: string; b: string; overlap: string[] }
export type MergePrediction = { safe: true } | { safe: false; pairs: MergePair[] }

export function predictMerges(patches: ReadonlyArray<PatchFiles>): MergePrediction {
  const pairs: MergePair[] = []
  for (let i = 0; i < patches.length; i++) {
    for (let j = i + 1; j < patches.length; j++) {
      const a = patches[i]!
      const b = patches[j]!
      const ov = a.files.filter((f) => b.files.includes(f))
      if (ov.length > 0) pairs.push({ a: a.id, b: b.id, overlap: ov })
    }
  }
  return pairs.length === 0 ? { safe: true } : { safe: false, pairs }
}