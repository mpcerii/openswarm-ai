export * as SwarmCredentials from "./credentials"

import { Schema } from "effect"
import { createHash } from "node:crypto"
import { ascending } from "@opencode-ai/schema/identifier"
import { NonNegativeInt, optional, DateTimeUtcFromMillis, statics } from "@opencode-ai/schema/schema"
import { SwarmWorker } from "./worker"

// Worker credentials scope what a remote worker may do. Credentials are
// revocable and time-bound; the raw secret is shown exactly once at issuance
// and only its hash is ever stored. Never log credentials.

export const ID = Schema.String.check(Schema.isStartsWith("swcr_")).pipe(
  Schema.brand("SwarmCredentials.ID"),
  statics((schema) => ({ create: () => schema.make("swcr_" + ascending()) })),
)
export type ID = typeof ID.Type

export interface Scopes extends Schema.Schema.Type<typeof Scopes> {}
export const Scopes = Schema.Struct({
  // Empty = the worker may serve any capability it declares. Non-empty =
  // intersection with the worker's declared capabilities.
  capabilities: Schema.Array(Schema.String),
  // Provider ids the worker may make LLM/tool calls against.
  providers: Schema.Array(Schema.String),
  // Model allowlist for this worker. Empty = inherit the human allowlist.
  models: Schema.Array(Schema.String),
  platforms: Schema.Array(Schema.String),
  maxConcurrentAgents: optional(NonNegativeInt),
}).annotate({ identifier: "SwarmCredentials.Scopes" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  workerID: SwarmWorker.ID,
  name: Schema.String,
  // hex(sha256(secret)). The raw secret is never persisted.
  secretHash: Schema.String,
  scopes: Scopes,
  revoked: Schema.Boolean,
  createdAt: DateTimeUtcFromMillis,
  expiresAt: optional(DateTimeUtcFromMillis),
}).annotate({ identifier: "SwarmCredentials.Info" })

// Durable row shape. `scopes` is JSON-encoded in SQLite.
export interface Record {
  id: string
  worker_id: string
  name: string
  secret_hash: string
  scopes: Scopes
  revoked: number
  created_at: number
  expires_at: number | null
}

// A secret scoped to a task/provider rather than to the whole project. A
// worker only ever receives the value for refs it is authorized for.
export interface Secret {
  ref: string
  value: string
  // Scope string like "provider:anthropic" or "repo:acme/backend". The
  // control plane authorizes access only when the worker credential's scopes
  // match the scope of the secret the agent's work requires.
  scope: string
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function makeSecret(secret: string): string {
  return sha256(secret)
}

export function verifySecret(secret: string, hash: string): boolean {
  return makeSecret(secret) === hash
}

// A credential is usable when not revoked and not expired.
export function isUsable(c: Record, now: number): boolean {
  if (c.revoked !== 0) return false
  if (c.expires_at !== null && c.expires_at < now) return false
  return true
}

// Scope check: is the worker allowed to touch the given secret scope? An empty
// provider list means the worker gets NO providers by default (fail-closed);
// an explicit provider entry is required.
export function allowsSecretScope(c: Record, secretScope: string): boolean {
  if (!secretScope.startsWith("provider:")) return true
  const providerID = secretScope.slice("provider:".length)
  if (c.scopes.providers.length === 0) return false
  return c.scopes.providers.includes(providerID)
}

export function allowsProvider(c: Record, providerID: string): boolean {
  if (c.scopes.providers.length === 0) return false
  return c.scopes.providers.includes(providerID)
}
