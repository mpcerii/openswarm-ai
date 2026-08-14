export * as SwarmClusterDdl from "./ddl"

// ---------------------------------------------------------------------------
// DDL for the durable distributed store (SqliteStore). Local mode keeps
// SQLite; a shared backend would reuse the same logical rows. Created
// idempotently at startup (CREATE TABLE IF NOT EXISTS); append-only schema
// evolution keeps v0 backward compatible.
// ---------------------------------------------------------------------------

export const CLUSTER_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS swarm_store_agent (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_store_agent_state ON swarm_store_agent(state)`,
  `CREATE TABLE IF NOT EXISTS swarm_store_mission (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS swarm_store_census (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS swarm_store_message (
    id TEXT PRIMARY KEY,
    to_agent TEXT NOT NULL,
    payload TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_store_message_to ON swarm_store_message(to_agent)`,
  `CREATE TABLE IF NOT EXISTS swarm_store_task (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS swarm_store_artifact (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS swarm_store_audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_store_audit_type ON swarm_store_audit(type)`,
  `CREATE TABLE IF NOT EXISTS swarm_store_worker (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    health TEXT NOT NULL,
    last_heartbeat INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_store_worker_health ON swarm_store_worker(health)`,
  `CREATE TABLE IF NOT EXISTS swarm_store_lease (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    worker_id TEXT,
    status TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    payload TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_store_lease_status ON swarm_store_lease(status)`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_store_lease_worker ON swarm_store_lease(worker_id)`,
  `CREATE TABLE IF NOT EXISTS swarm_store_op (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    op_key TEXT NOT NULL,
    result TEXT,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE(kind, op_key)
  )`,
  `CREATE TABLE IF NOT EXISTS swarm_store_credential (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS swarm_store_secret (
    ref TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    scope TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS swarm_store_spawn (
    parent_id TEXT PRIMARY KEY,
    children INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS swarm_store_mission_budget (
    mission_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS swarm_store_agent_budget (
    agent_id TEXT PRIMARY KEY,
    parent_id TEXT,
    mission_id TEXT NOT NULL,
    payload TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_store_agent_budget_parent ON swarm_store_agent_budget(parent_id)`,
  `CREATE TABLE IF NOT EXISTS swarm_store_concurrency (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    population INTEGER NOT NULL DEFAULT 0,
    active_agents INTEGER NOT NULL DEFAULT 0,
    active_agents_peak INTEGER NOT NULL DEFAULT 0,
    active_llm INTEGER NOT NULL DEFAULT 0,
    active_llm_peak INTEGER NOT NULL DEFAULT 0,
    active_workspaces INTEGER NOT NULL DEFAULT 0,
    workspace_peak INTEGER NOT NULL DEFAULT 0,
    max_active_llm INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS swarm_store_queue (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    visible_at INTEGER NOT NULL,
    claim_token TEXT,
    claimed_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_store_queue_visible ON swarm_store_queue(visible_at)`,
  `CREATE TABLE IF NOT EXISTS swarm_store_model (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS swarm_store_memory (
    key TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
]
