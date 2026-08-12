export * as SwarmQueue from "./queue"

// Queue/event abstraction shared by the control plane's scheduler and the
// workers. Decoupled from the scheduler itself: the scheduler publishes and
// claims via this interface; in-memory and database-backed implementations
// live next to it. Delivery is at-least-once with a visibility timeout and a
// claim token — only the token holder may ack/nack/extend a message, which
// prevents two workers committing the same execution.

export interface Message {
  id: string
  kind: string
  // JSON-encoded payload (e.g. a lease id).
  payload: string
  visibleAt: number
  claimToken: string | null
  claimedAt: number | null
  attempts: number
  createdAt: number
}

export interface Claimed {
  id: string
  kind: string
  payload: string
  claimToken: string
  attempts: number
}

export interface PublishInput {
  id: string
  kind: string
  payload: string
  // When the message becomes visible to consumers.
  visibleAt: number
  createdAt: number
}

export interface Backend {
  readonly kind: "memory" | "database"
  publish(msg: PublishInput): Promise<void>
  // Atomically claim up to `max` visible messages, optionally restricted to a
  // single kind (used to shard lease deliveries per worker). Each returned
  // message is marked claimed with a fresh token; nobody else may touch it
  // until it is acked, nacked (made visible again), extended, or re-visible
  // after its visibility window lapses.
  claim(max: number, now: number, kind?: string): Promise<Claimed[]>
  ack(id: string, claimToken: string): Promise<boolean>
  nack(id: string, claimToken: string, visibleAt: number): Promise<boolean>
  extend(id: string, claimToken: string, visibleAt: number): Promise<boolean>
  depth(): Promise<number>
}
