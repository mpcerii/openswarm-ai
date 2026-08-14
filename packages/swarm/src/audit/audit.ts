export * as SwarmAudit from "./audit"

import { SwarmEvents } from "../events/events"

// Sensitive substrings we redact from event payloads / summaries before
// persistence. The audit log feeds /why and the TUI; it must never leak raw
// secrets even if an agent quoted one. Keys are matched case-insensitively
// against the textual (stringified) form of an event's metadata or summary.
const SECRET_KEYS = [
  "token", "secret", "password", "passwd", "apikey", "api_key", "key",
  "credential", "auth", "bearer", "session_id_raw",
]
const SECRET_HINTS = /^(sk-|sk_)+|ghp_|gho_|AKIA|xoxb-|-----BEGIN .* PRIVATE KEY-----/

export function redactString(input: string): string {
  return input.replace(
    /("(?:token|secret|password|passwd|apikey|api_key|key|credential|auth|bearer|session_id_raw)"\s*:\s*")(?:[^"\\]|\\.)*(")/gi,
    "$1<redacted>$2",
  ).replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1<redacted>")
    .replace(/(ghp_[A-Za-z0-9]{6})[A-Za-z0-9]+/g, "$1<redacted>")
    .replace(/(xoxb-[A-Za-z0-9-]{6})[A-Za-z0-9-]+/g, "$1<redacted>")
    .replace(/(AKIA[A-Z0-9]{4})[A-Z0-9]+/g, "$1<redacted>")
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]+?-----END [^-]+ PRIVATE KEY-----/g, "<redacted-key>")
}

export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value)
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lk = k.toLowerCase()
      if (SECRET_KEYS.some((s) => lk.includes(s))) {
        out[k] = "<redacted>"
        continue
      }
      if (!Array.isArray(v) && typeof v === "string" && SECRET_HINTS.test(v)) {
        out[k] = "<redacted>"
        continue
      }
      out[k] = redact(v)
    }
    return out
  }
  return value
}

export type StoredEvent = {
  type: string
  time: number
  data: unknown
}

// In-memory event sink. Reuses the durable event vocabulary from
// SwarmEvents.Definitions but writes a flat, append-only, redacted store. The
// real openSwarm bridge later reuses `EventV2` durability; this stand-in keeps
// the kernel testable & deterministic without SQLite.
export interface AuditLog {
  readonly events: StoredEvent[]
  // Indexes built incrementally so /why and the TUI panel stay O(1) per lookup
  // even at 10k-agent scale. Pure-ish: writes are append-only.
  readonly byType: Map<string, number[]>
  readonly byAgent: Map<string, number[]>
}

export function emptyAuditLog(): AuditLog {
  return { events: [], byType: new Map(), byAgent: new Map() }
}

export function emit(log: AuditLog, type: string, data: unknown, now: number): number {
  const entry: StoredEvent = { type, time: now, data: redact(data) }
  const index = log.events.length
  log.events.push(entry)
  const byType = log.byType.get(type) ?? []
  byType.push(index)
  log.byType.set(type, byType)
  const d = data as Record<string, unknown> | undefined
  if (d && typeof d === "object" && typeof d.agentID === "string") {
    const byAgent = log.byAgent.get(d.agentID) ?? []
    byAgent.push(index)
    log.byAgent.set(d.agentID, byAgent)
  }
  return index
}

export function emitPayload(log: AuditLog, type: string, payload: { agentID?: string } & Record<string, unknown>, now: number): number {
  return emit(log, type, payload, now)
}

export function forType(log: AuditLog, type: string): StoredEvent[] {
  const indices = log.byType.get(type) ?? []
  return indices.map((i) => log.events[i]!)
}

export function forAgent(log: AuditLog, agentID: string): StoredEvent[] {
  const indices = log.byAgent.get(agentID) ?? []
  return indices.map((i) => log.events[i]!)
}

export const knownEventTypes = SwarmEvents.Definitions.map((d: typeof SwarmEvents.Definitions[number]) => d.type)