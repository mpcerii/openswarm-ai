export * as SwarmCensus from "./census"

import { Schema } from "effect"
import { ascending } from "@opencode-ai/schema/identifier"
import { optional, DateTimeUtcFromMillis, statics } from "@opencode-ai/schema/schema"
import { SwarmArtifact } from "../artifacts/artifact"

// Census is itself a reusable artifact: agents consult this map when dividing
// work so the kernel does NOT need to send the whole repo into every agent's
// context. The map is structured & small — under a few KB even for large
// repos with hundreds of modules — and persisted alongside mission records.
export const ID = Schema.String.check(Schema.isStartsWith("swc_")).pipe(
  Schema.brand("SwarmCensus.ID"),
  statics((schema) => ({ create: () => schema.make("swc_" + ascending()) })),
)
export type ID = typeof ID.Type

export interface Module extends Schema.Schema.Type<typeof Module> {}
export const Module = Schema.Struct({
  path: Schema.String,
  language: optional(Schema.String),
  // Glob-style roots this module controls; used to allocate leases for
  // implementation agents without overlapping investigators.
  area: Schema.String,
  // Entry points (relative to repo root) inside this module.
  entryPoints: Schema.Array(Schema.String),
  // Exports that other modules consume (top-level names only).
  exports: Schema.Array(Schema.String),
  dependsOn: Schema.Array(Schema.String),
  testCommand: optional(Schema.String),
  typecheckCommand: optional(Schema.String),
  buildCommand: optional(Schema.String),
  lintCommand: optional(Schema.String),
}).annotate({ identifier: "SwarmCensus.Module" })

export const RiskFileKind = Schema.Literals([
  "migration",
  "config",
  "schema",
  "dependency_manifest",
  "ci_pipeline",
  "protected_branch_policy",
  "secret_loader",
  "destructive_op",
]).annotate({ identifier: "SwarmCensus.RiskFileKind" })
export type RiskFileKind = typeof RiskFileKind.Type

export interface HighRiskFile extends Schema.Schema.Type<typeof HighRiskFile> {}
export const HighRiskFile = Schema.Struct({
  path: Schema.String,
  kind: RiskFileKind,
  reason: Schema.String,
}).annotate({ identifier: "SwarmCensus.HighRiskFile" })

export interface DatabaseTable extends Schema.Schema.Type<typeof DatabaseTable> {}
export const DatabaseTable = Schema.Struct({
  name: Schema.String,
  migration: optional(Schema.String),
}).annotate({ identifier: "SwarmCensus.DatabaseTable" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  rootPath: Schema.String,
  // snake_case names of package roots (e.g. "packages/swarm"). Stable
  // reference for lease areas and conflict reporting.
  packages: Schema.Array(Schema.String),
  modules: Schema.Array(Module),
  extraEntryPoints: Schema.Array(Schema.String),
  database: Schema.Array(DatabaseTable),
  highRiskFiles: Schema.Array(HighRiskFile),
  // Areas where multiple unrelated changes would conflict (e.g. shared schema,
  // HttpApi groups). Agents targeting these MUST acquire exclusive leases.
  conflictZones: Schema.Array(Schema.String),
  // References to the artifact that backs this census (snapshot hash later).
  artifactID: optional(SwarmArtifact.ID),
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "SwarmCensus.Info" })

// Lookup helpers used by the runtime when assigning tasks to investigator/
// implementer agents. Pure and indexed for predictable performance with
// thousands of agents reading concurrently.
export function moduleForPath(census: Info, absPath: string): Module | undefined {
  return census.modules.find((m) => absPath === m.path || absPath.startsWith(m.path + "/"))
}

export function isHighRisk(census: Info, path: string): HighRiskFile | undefined {
  return census.highRiskFiles.find((f) => f.path === path)
}

export function conflictZoneForPath(census: Info, path: string): string | undefined {
  return census.conflictZones.find((z) => path === z || path.startsWith(z + "/"))
}