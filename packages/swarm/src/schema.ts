export * as SwarmSchema from "./schema"

import type { Database as BunSqliteDatabase } from "bun:sqlite"
import type { SwarmAgent } from "./agent/agent"
import type { SwarmTask } from "./task/task"
import type { SwarmMessage } from "./messaging/message"
import type { SwarmArtifact } from "./artifacts/artifact"
import type { SwarmConfig } from "./config/config"

// ---------------------------------------------------------------------------
// Durable row shapes. snake_case column names so Drizzle doesn't need to
// redefine them as strings (per repo style). These mirror the Effect Schema
// `Info` types but are plain TS interfaces for raw-SQL access.
// ---------------------------------------------------------------------------

export interface BudgetRow {
  max_agents: number
  max_active_agents: number
  max_depth: number
  max_children_per_agent: number
  max_active_coding_workspaces: number
  population: number
  active: number
}

export interface AgentRow {
  id: string
  root_id: string
  parent_id: string | null
  depth: number
  role: string | null
  mission: string
  state: string
  requested_model: string | null
  resolved_model: string | null
  spawn_credits: number
  token_limit: number | null
  cost_limit: number | null
  session_id: string | null
  task_ids: string // json
  created_at: number
  updated_at: number
}

export interface TaskRow {
  id: string
  agent_id: string
  parent_id: string | null
  title: string
  description: string | null
  state: string
  created_at: number
  updated_at: number
}

export interface MessageRow {
  id: string
  from_sender: string
  to_agent_id: string
  delivery: string
  body: string
  in_reply_to: string | null
  created_at: number
}

export interface ArtifactRow {
  id: string
  agent_id: string
  task_id: string | null
  kind: string
  ref: string
  summary: string | null
  created_at: number
}

export interface EventRow {
  id: string
  aggregate_id: string
  type: string
  payload: string // json
  seq: number
  created_at: number
}

export interface WaitRow {
  id: string
  parent_agent_id: string
  child_ids: string // json
  mode: string
  created_at: number
}

// A parameterized query. Run via `db.prepare(q.sql).all(...q.params)`.
export interface Query {
  sql: string
  params: unknown[]
}

// ---------------------------------------------------------------------------
// DDL. Created idempotently at startup (CREATE TABLE IF NOT EXISTS). A proper
// migration pipeline is future work; for v0 the schema is append-only and
// backward compatible.
// ---------------------------------------------------------------------------

export const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS swarm_budget (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    max_agents INTEGER NOT NULL,
    max_active_agents INTEGER NOT NULL,
    max_depth INTEGER NOT NULL,
    max_children_per_agent INTEGER NOT NULL,
    max_active_coding_workspaces INTEGER NOT NULL,
    population INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS swarm_agent (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    parent_id TEXT,
    depth INTEGER NOT NULL,
    role TEXT,
    mission TEXT NOT NULL,
    state TEXT NOT NULL,
    requested_model TEXT,
    resolved_model TEXT,
    spawn_credits INTEGER NOT NULL DEFAULT 0,
    token_limit INTEGER,
    cost_limit REAL,
    session_id TEXT,
    task_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS swarm_task (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    parent_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS swarm_message (
    id TEXT PRIMARY KEY,
    from_sender TEXT NOT NULL,
    to_agent_id TEXT NOT NULL,
    delivery TEXT NOT NULL,
    body TEXT NOT NULL,
    in_reply_to TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS swarm_artifact (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    task_id TEXT,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    summary TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS swarm_event (
    id TEXT PRIMARY KEY,
    aggregate_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS swarm_wait (
    id TEXT PRIMARY KEY,
    parent_agent_id TEXT NOT NULL,
    child_ids TEXT NOT NULL,
    mode TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_agent_parent ON swarm_agent(parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_agent_root ON swarm_agent(root_id)`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_agent_state ON swarm_agent(state)`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_agent_depth ON swarm_agent(depth)`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_task_agent ON swarm_task(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_message_to ON swarm_message(to_agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_event_seq ON swarm_event(seq)`,
]

// Seed the global budget row from config. Idempotent.
export function seedBudget(config: SwarmConfig.Info): string[] {
  const b = config
  return [
    `INSERT INTO swarm_budget (id, max_agents, max_active_agents, max_depth, max_children_per_agent, max_active_coding_workspaces, population, active)
     VALUES (${b.max_agents}, ${b.max_active_agents}, ${b.max_depth}, ${b.max_children_per_agent}, ${b.max_active_coding_workspaces}, 0, 0)
     ON CONFLICT(id) DO UPDATE SET
       max_agents = excluded.max_agents,
       max_active_agents = excluded.max_active_agents,
       max_depth = excluded.max_depth,
       max_children_per_agent = excluded.max_children_per_agent,
       max_active_coding_workspaces = excluded.max_active_coding_workspaces`,
  ]
}

// ---------------------------------------------------------------------------
// Query helpers (typed). Each returns a parameterized Query.
// ---------------------------------------------------------------------------

export const queries = {
  agentByID: (id: string): Query => ({ sql: "SELECT * FROM swarm_agent WHERE id = ?", params: [id] }),
  childrenOf: (parentID: string): Query => ({
    sql: "SELECT * FROM swarm_agent WHERE parent_id = ? ORDER BY created_at ASC",
    params: [parentID],
  }),
  descendants: (rootID: string): Query => ({
    sql: "SELECT * FROM swarm_agent WHERE root_id = ? ORDER BY depth ASC, created_at ASC",
    params: [rootID],
  }),
  agentsByState: (state: string): Query => ({
    sql: "SELECT * FROM swarm_agent WHERE state = ? ORDER BY created_at ASC",
    params: [state],
  }),
  budget: (): Query => ({ sql: "SELECT * FROM swarm_budget WHERE id = 1", params: [] }),
  waitingOn: (parentID: string): Query => ({
    sql: "SELECT * FROM swarm_wait WHERE parent_agent_id = ? ORDER BY created_at ASC",
    params: [parentID],
  }),
  eventsForAgent: (agentID: string): Query => ({
    sql: "SELECT * FROM swarm_event WHERE aggregate_id = ? ORDER BY seq ASC",
    params: [agentID],
  }),
}

export type Database = BunSqliteDatabase
