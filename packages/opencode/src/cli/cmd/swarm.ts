import type { CommandModule, Argv } from "yargs"
import { cmd } from "./cmd"
import { SwarmWorker } from "@opencode-ai/swarm/cluster/worker"
import { SwarmCredentials } from "@opencode-ai/swarm/cluster/credentials"
import { SwarmClusterSim } from "@opencode-ai/swarm/simulation/cluster-simulation"
import { SwarmAgent } from "@opencode-ai/swarm/agent/agent"
import type { SwarmConfig } from "@opencode-ai/swarm/config/config"
import type { ControlPlane } from "@opencode-ai/swarm/control/control"
import type { WorkerNode } from "@opencode-ai/swarm/worker/node"

// ---------------------------------------------------------------------------
// openSwarm distributed runtime CLI. `openswarm swarm server` runs the control
// plane (durable SQLite store + scheduler + worker registry); `worker start`
// runs a worker node; `worker drain` drains one; `status` prints cluster
// metrics. Phase 1 wires the in-process transport: a remote worker would
// implement the same ControlPlaneApi over an authenticated network transport.
// ---------------------------------------------------------------------------

const DEFAULT_LIMITS = { max_agents: 10000, max_active_agents: 64, max_depth: 12, max_children_per_agent: 500 }
const DEFAULT_WORKSPACE = Math.max(1, Math.floor(64 / 2))

function dbPath(explicit?: string): string {
  if (explicit) return explicit
  const dataDir = process.env.OPENCODE_DATA ?? ".opencode"
  return `${dataDir}/swarm-cluster.db`
}

function clusterConfig(activeBound: number, llmCap: number): SwarmConfig.Info {
  return SwarmClusterSim.defaultClusterConfig({
    population: 10000,
    activeBound,
    workspaceBound: DEFAULT_WORKSPACE,
    childrenPerAgent: 500,
    maxDepth: 12,
    workerCount: 1,
    maxConcurrentPerWorker: 8,
    llmCap,
  })
}

const serverSub: CommandModule = {
  command: "server",
  describe: "run the control plane (durable state, scheduler, worker registry)",
  builder: (yargs: Argv) =>
    yargs
      .option("db", { describe: "SQLite database path", type: "string" })
      .option("workers", { describe: "number of local workers to run in-process", type: "number", default: 2 })
      .option("max-active", { describe: "global active agent bound", type: "number", default: 32 })
      .option("llm-cap", { describe: "global LLM concurrency cap", type: "number", default: 64 })
      .option("demo", { describe: "spawn a small demo mission", type: "boolean", default: false }),
  handler: async (args) => {
    const opts = args as unknown as { db?: string; workers: number; "max-active": number; "llm-cap": number; demo: boolean }
    await runServer(opts)
  },
}

const workerStartSub: CommandModule = {
  command: "worker start",
  describe: "start a worker node (in-process transport to the control plane's store)",
  builder: (yargs: Argv) =>
    yargs
      .option("db", { describe: "SQLite database path shared with the server", type: "string" })
      .option("name", { describe: "worker name", type: "string", default: "local-worker" })
      .option("max-concurrent", { describe: "max concurrent agents on this worker", type: "number", default: 8 })
      .option("models", { describe: "comma-separated models this worker can serve", type: "string" }),
  handler: async (args) => {
    const opts = args as unknown as { db?: string; name: string; "max-concurrent": number; models?: string }
    await runWorker(opts)
  },
}

const workerDrainSub: CommandModule = {
  command: "worker drain <id>",
  describe: "drain a worker: stop new leases, finish current, go offline",
  builder: (yargs: Argv) =>
    yargs
      .positional("id", { describe: "worker id", type: "string" })
      .option("db", { describe: "SQLite database path", type: "string" }),
  handler: async (args) => {
    const opts = args as unknown as { db?: string; id: string }
    await runDrain(opts)
  },
}

const statusSub: CommandModule = {
  command: "status",
  describe: "print cluster metrics",
  builder: (yargs: Argv) => yargs.option("db", { describe: "SQLite database path", type: "string" }),
  handler: async (args) => {
    const opts = args as unknown as { db?: string }
    await runStatus(opts)
  },
}

// Real status: reads the actual swarm.db store written by the running instance
// (SwarmService) plus the user's swarm config from opencode.json. This is the
// "not fake data" path for `openswarm swarm status`.
const realStatusSub: CommandModule = {
  command: "real-status",
  describe: "print REAL runtime swarm state (agents, budgets, approved models) from the active instance store",
  builder: (yargs: Argv) => yargs.option("config", { describe: "opencode config file path", type: "string" }),
  handler: async (args) => {
    const opts = args as unknown as { config?: string }
    await runRealStatus(opts)
  },
}

export const SwarmCommand: CommandModule = cmd({
  command: "swarm",
  describe: "openSwarm distributed runtime (control plane, workers, cluster status)",
  builder: (yargs) =>
    yargs
      .command(serverSub)
      .command(workerStartSub)
      .command(workerDrainSub)
      .command(statusSub)
      .command(realStatusSub)
      .demandCommand(1),
  handler: async (args) => {
    void args
    // yargs prints the help listing when a subcommand is missing.
    process.stdout.write("openswarm swarm requires a subcommand: server | worker start | worker drain | status | real-status\n")
  },
})

interface ServerArgs {
  db?: string
  workers: number
  "max-active": number
  "llm-cap": number
  demo: boolean
}

async function runServer(args: ServerArgs): Promise<never> {
  const { SqliteStore } = await import("@opencode-ai/swarm/storage/sqlite")
  const { ControlPlane } = await import("@opencode-ai/swarm/control/control")
  const { WorkerNode } = await import("@opencode-ai/swarm/worker/node")
  const store = new SqliteStore(dbPath(args.db), DEFAULT_LIMITS, args["llm-cap"], DEFAULT_WORKSPACE)
  const control = new ControlPlane({ store, config: clusterConfig(args["max-active"], args["llm-cap"]), llmCap: args["llm-cap"] })

  const workers: WorkerNode[] = []
  for (let i = 0; i < args.workers; i++) {
    const worker = await makeLocalWorker(control, `server-worker-${i + 1}`, 8)
    const registered = await worker.register()
    if (!registered) throw new Error(`server-worker-${i + 1} rejected by control plane`)
    workers.push(worker)
  }
  if (args.demo) {
    const primaryID = SwarmAgent.ID.create()
    const mission = await control.createMission({ title: "demo mission", brief: "smoke", primaryAgentID: primaryID })
    await control.registerPrimary({ missionID: mission.id, agentID: primaryID })
    for (let i = 0; i < 24; i++) {
      await control.spawn(primaryID, { missionID: mission.id, role: i % 3 === 0 ? "investigator" : "echo" })
    }
    console.log(`demo mission ${mission.id} spawned (24 agents)`)
  }

  console.log(`swarm control plane running (db=${dbPath(args.db)}, workers=${args.workers})`)
  for (;;) {
    await control.tick()
    for (const worker of workers) {
      if (!worker.terminated) await worker.pump()
    }
    const metrics = await control.metrics()
    console.log(
      JSON.stringify({
        connected: metrics.connectedWorkers,
        active: metrics.globalActiveAgents,
        activeLLM: metrics.globalActiveLLM,
        queueDepth: metrics.queueDepth,
        leased: metrics.leasedTasks,
        failedLeases: metrics.failedLeases,
        retries: metrics.retries,
      }),
    )
    await Bun.sleep(1000)
  }
}

interface WorkerArgs {
  db?: string
  name: string
  "max-concurrent": number
  models?: string
}

async function runWorker(args: WorkerArgs): Promise<never> {
  const { SqliteStore } = await import("@opencode-ai/swarm/storage/sqlite")
  const { ControlPlane } = await import("@opencode-ai/swarm/control/control")
  const { WorkerNode } = await import("@opencode-ai/swarm/worker/node")
  const store = new SqliteStore(dbPath(args.db), DEFAULT_LIMITS, 64, DEFAULT_WORKSPACE)
  const control = new ControlPlane({ store, config: clusterConfig(64, 64), llmCap: 64 })
  const worker = await makeLocalWorker(control, args.name, args["max-concurrent"], args.models)
  const registered = await worker.register()
  if (!registered) throw new Error("worker rejected by control plane (credential failed)")
  console.log(`swarm worker ${worker.id} registered as ${args.name}`)
  for (;;) {
    await worker.pump()
    await Bun.sleep(250)
  }
}

async function makeLocalWorker(control: ControlPlane, name: string, maxConcurrent: number, models?: string): Promise<WorkerNode> {
  const { WorkerNode } = await import("@opencode-ai/swarm/worker/node")
  const workerID = SwarmWorker.ID.create()
  const { credential, secret } = await control.issueCredential({
    workerID,
    name,
    scopes: { capabilities: [], providers: [], models: [], platforms: [] } satisfies SwarmCredentials.Scopes,
  })
  const worker = new WorkerNode({
    id: workerID,
    name,
    capabilities: {
      workerID,
      maxConcurrentAgents: maxConcurrent,
      maxConcurrentTools: maxConcurrent * 2,
      supportedPlatforms: ["linux", "win32"],
      capabilities: ["coding-workspace", "review"],
      availableModels: models ? models.split(",").map((m) => m.trim()).filter(Boolean) : ["fake/echo"],
      git: true,
      shell: false,
      sandbox: true,
    },
    credentialID: credential.id,
    secret,
    provider: { async *stream() { yield { finish: "stop", tokens: 8 } } },
    api: control,
  })
  return worker
}

interface DrainArgs {
  db?: string
  id: string
}

async function runDrain(args: DrainArgs): Promise<void> {
  const { SqliteStore } = await import("@opencode-ai/swarm/storage/sqlite")
  const { ControlPlane } = await import("@opencode-ai/swarm/control/control")
  const store = new SqliteStore(dbPath(args.db), DEFAULT_LIMITS, 64, DEFAULT_WORKSPACE)
  const control = new ControlPlane({ store, config: clusterConfig(64, 64), llmCap: 64 })
  const worker = await store.getWorker(args.id)
  if (worker === undefined) throw new Error(`worker not found: ${args.id}`)
  await control.drain(args.id, Date.now())
  console.log(`worker ${args.id} draining`)
}

interface StatusArgs {
  db?: string
}

async function runStatus(args: StatusArgs): Promise<void> {
  const { SqliteStore } = await import("@opencode-ai/swarm/storage/sqlite")
  const { ControlPlane } = await import("@opencode-ai/swarm/control/control")
  const store = new SqliteStore(dbPath(args.db), DEFAULT_LIMITS, 64, DEFAULT_WORKSPACE)
  const control = new ControlPlane({ store, config: clusterConfig(64, 64), llmCap: 64 })
  const metrics = await control.metrics()
  console.log(JSON.stringify(metrics, null, 2))
}

interface RealStatusArgs {
  config?: string
}

// Reads the REAL runtime store used by the running opencode instance
// (Global.Path.data/swarm.db) plus the user's opencode.json swarm config.
async function runRealStatus(args: RealStatusArgs): Promise<void> {
  const { SqliteStore } = await import("@opencode-ai/swarm/storage/sqlite")
  const { SwarmConfigBridge } = await import("@/swarm/config")
  const { Global } = await import("@opencode-ai/core/global")
  const { join } = await import("node:path")
  const { ConfigParse } = await import("@/config/parse")
  const fs = await import("node:fs")

  // Load the user's EFFECTIVE config (global + project) to read swarm.*.
  // The TUI merges the global config with project files; mirror that order here
  // so real-status reports the same state the running TUI actually uses.
  const isRecord = (x: unknown): x is Record<string, unknown> =>
    typeof x === "object" && x !== null && !Array.isArray(x)
  const merge = (base: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(next)) {
      out[key] = isRecord(out[key]) && isRecord(value) ? merge(out[key] as Record<string, unknown>, value) : value
    }
    return out
  }
  const files =
    args.config !== undefined
      ? [args.config]
      : [
          join(Global.Path.config, "opencode.jsonc"),
          join(Global.Path.config, "opencode.json"),
          join(Global.Path.config, "config.json"),
          join(process.cwd(), ".openswarm", "opencode.jsonc"),
          join(process.cwd(), ".openswarm", "opencode.json"),
          join(process.cwd(), ".opencode", "opencode.jsonc"),
          join(process.cwd(), ".opencode", "opencode.json"),
          join(process.cwd(), "opencode.jsonc"),
          join(process.cwd(), "opencode.json"),
        ]
  let merged: Record<string, unknown> = {}
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    try {
      merged = merge(merged, ConfigParse.jsonc(fs.readFileSync(file, "utf8"), file) as Record<string, unknown>)
    } catch {
      // Ignore unparsable config files.
    }
  }
  const swarmV1 = (merged as { swarm?: import("@opencode-ai/core/v1/config/swarm").ConfigSwarmV1.Info }).swarm
  const runtime = SwarmConfigBridge.swarmConfigFromV1(swarmV1)

  const store = new SqliteStore(
    join(Global.Path.data, "swarm.db"),
    { max_agents: runtime.max_agents, max_active_agents: runtime.max_active_agents, max_depth: runtime.max_depth, max_children_per_agent: runtime.max_children_per_agent },
    64,
    runtime.max_active_coding_workspaces,
  )
  const accounting = await store.accounting()
  const agents = await store.listAgents()
  const stateCounts: Record<string, number> = {}
  for (const a of agents) stateCounts[a.state] = (stateCounts[a.state] ?? 0) + 1
  const models = await store.listAgents().then((as) => [...new Set(as.map((a) => a.resolvedModel).filter(Boolean))] as string[])

  console.log(
    JSON.stringify(
      {
        enabled: runtime.enabled,
        models: { allowed: runtime.models.allowed, approved: models.length },
        population: { current: accounting.population, max: runtime.max_agents },
        active: { agents: accounting.activeAgents, max: runtime.max_active_agents, llm: accounting.activeLLM, peak: accounting.activeAgentsPeak },
        workspaces: { active: accounting.activeWorkspaces, max: runtime.max_active_coding_workspaces },
        agentsByState: stateCounts,
        agentsTotal: agents.length,
        errors: SwarmConfigBridge.validateSwarmConfig(swarmV1),
      },
      null,
      2,
    ),
  )
  store.close()
}
