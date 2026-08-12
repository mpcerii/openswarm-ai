export * as SwarmDb from "./db"

import type { Database as BunSqliteDatabase } from "bun:sqlite"
import { DDL, seedBudget } from "./schema"
import type { SwarmConfig } from "./config/config"

// Swarm DB Service interface — owned by the swarm package, the durable
// storage layer is wired through the upstream `effect-drizzle-sqlite` /
// `bun:sqlite` stack at integration time. This contract exposes only the
// helpers the kernel needs; concrete runnables live in `./schema.ts` row
// interfaces plus `./registry.ts`'s queries. The kernel itself does NOT
// depend on this file — it's a seam for the future persistence bridge.
export interface Service {
  readonly db: BunSqliteDatabase
}

// openSwarm swarm database. A SEPARATE file from opencode.db so the swarm
// layer owns its schema end-to-end and never couples core to swarm. Lives in
// the instance data dir alongside opencode.db.
export function make(path: string, config: SwarmConfig.Info): Service {
  // Imported dynamically so the swarm package's static dependency footprint
  // remains schema+effect only; the upstream persistence bridge ends up being
  // loaded lazily through the same seam when present.
  const { Database } = require("bun:sqlite") as { Database: typeof BunSqliteDatabase }
  const db = new Database(path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  for (const stmt of DDL) db.exec(stmt)
  for (const stmt of seedBudget(config)) db.exec(stmt)
  return { db }
}
