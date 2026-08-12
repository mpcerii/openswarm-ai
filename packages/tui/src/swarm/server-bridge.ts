import type { SwarmUiSnapshot } from "./state/types"
import { buildSnapshotFromServer } from "./state/snapshot"

// ---------------------------------------------------------------------------
// ServerSwarmBridge: reads REAL swarm runtime state from the opencode server
// (/swarm/status + /swarm/agents) over the existing transport. This replaces
// the demo-seeded in-process bridge so `/swarm` shows actual scheduler state —
// population, active bounds, approved models, per-agent states — never fake
// data. Actions (approve/reject/cancel/pause) are intentionally NOT surfaced
// here yet: they must be added as server endpoints before the overlay can
// mutate real state.
// ---------------------------------------------------------------------------

export interface ServerBridgeOptions {
  readonly fetch: typeof fetch
  readonly url: string
  readonly directory?: string
  readonly headers?: RequestInit["headers"]
  // Called after a successful mutation so the overlay refreshes real state.
  readonly onMutate?: () => void
}

export class ServerSwarmBridge {
  readonly now: () => number
  private readonly fetch: typeof fetch
  private readonly url: string
  private readonly directory?: string
  private readonly headers?: RequestInit["headers"]
  private readonly onMutate?: () => void
  private snapshotValue: SwarmUiSnapshot
  private errorValue: string | undefined

  constructor(opts: ServerBridgeOptions, now: () => number = Date.now) {
    this.fetch = opts.fetch
    this.url = opts.url
    this.directory = opts.directory
    this.headers = opts.headers
    this.onMutate = opts.onMutate
    this.now = now
    this.snapshotValue = buildSnapshotFromServer(
      {
        enabled: false,
        models: { allowed: [], approved: 0 },
        population: { current: 0, max: 0 },
        active: { agents: 0, max: 0, llm: 0, peak: 0 },
        workspaces: { active: 0, max: 0 },
        agentsByState: {},
        agentsTotal: 0,
        errors: [],
      },
      { agents: [] },
      now(),
    )
    this.errorValue = undefined
  }

  snapshot(): SwarmUiSnapshot {
    return this.snapshotValue
  }

  error(): string | undefined {
    return this.errorValue
  }

  // Configuration/bridge diagnostics surfaced by the server (e.g. "swarm
  // enabled but no authorized models"). Separate from transport errors so the
  // UI can show precise reasons instead of a bare "missing data".
  private configErrorsValue: string[] = []
  configErrors(): string[] {
    return this.configErrorsValue
  }

  async tick(): Promise<void> {
    try {
      const status = await this.getStatus()
      const agents = await this.getAgents()
      this.snapshotValue = buildSnapshotFromServer(status, agents, this.now())
      this.configErrorsValue = status.errors
      this.errorValue = undefined
    } catch (error) {
      this.errorValue = error instanceof Error ? error.message : String(error)
    }
  }

  private async getStatus(): Promise<{
    enabled: boolean
    models: { allowed: string[]; approved: number }
    modelStates: Array<{ id: string; provider: string; available: boolean }>
    population: { current: number; max: number }
    active: { agents: number; max: number; llm: number; peak: number }
    workspaces: { active: number; max: number }
    agentsByState: Record<string, number>
    agentsTotal: number
    errors: string[]
  }> {
    const url = this.endpoint("/swarm/status")
    const res = await this.fetch(url, { headers: this.headers })
    if (!res.ok) throw new Error(`swarm status: HTTP ${res.status} ${res.statusText}`)
    const body = (await res.json()) as Record<string, unknown>
    // The swarm status endpoint returns the status object DIRECTLY (no
    // { data: ... } wrapper) — see test/server/swarm-contract.test.ts. Some
    // SDK-generated transports wrap responses in `data`; tolerate both so the
    // bridge stays correct whichever layer it talks to.
    const data = (body.data !== undefined && typeof body.data === "object" ? body.data : body) as {
      enabled?: boolean
      models?: { allowed?: string[]; approved?: number }
      modelStates?: Array<{ id: string; provider: string; available: boolean }>
      population?: { current?: number; max?: number }
      active?: { agents?: number; max?: number; llm?: number; peak?: number }
      workspaces?: { active?: number; max?: number }
      agentsByState?: Record<string, number>
      agentsTotal?: number
      errors?: string[]
    }
    const missing = (label: string, value: unknown) => {
      if (value === undefined || value === null) throw new Error(`swarm status: missing field ${label}`)
    }
    missing("enabled", data.enabled)
    missing("population", data.population)
    missing("active", data.active)
    missing("models", data.models)
    missing("agentsByState", data.agentsByState)
    return {
      enabled: data.enabled as boolean,
      models: { allowed: data.models?.allowed ?? [], approved: data.models?.approved ?? 0 },
      modelStates: data.modelStates ?? [],
      population: { current: data.population?.current ?? 0, max: data.population?.max ?? 0 },
      active: { agents: data.active?.agents ?? 0, max: data.active?.max ?? 0, llm: data.active?.llm ?? 0, peak: data.active?.peak ?? 0 },
      workspaces: { active: data.workspaces?.active ?? 0, max: data.workspaces?.max ?? 0 },
      agentsByState: data.agentsByState ?? {},
      agentsTotal: data.agentsTotal ?? 0,
      errors: data.errors ?? [],
    }
  }

  private async getAgents(): Promise<{
    agents: Array<{ id: string; state: string; role?: string; model?: string; sessionID?: string; mission: string }>
  }> {
    const url = this.endpoint("/swarm/agents")
    const res = await this.fetch(url, { headers: this.headers })
    if (!res.ok) throw new Error(`swarm agents: HTTP ${res.status} ${res.statusText}`)
    const body = (await res.json()) as Record<string, unknown>
    const data = (body.data !== undefined && typeof body.data === "object" ? body.data : body) as {
      agents?: Array<{ id: string; state: string; role?: string; model?: string; sessionID?: string; mission: string }>
    }
    return { agents: data.agents ?? [] }
  }

  // /why provenance: returns stored operational facts for a file or agent id.
  async provenance(target: string): Promise<string> {
    const base = this.url.replace(/\/+$/, "")
    const dir = this.directory
    const query = new URLSearchParams()
    query.set("target", target)
    if (dir !== undefined && dir !== "") query.set("directory", dir)
    const res = await this.fetch(`${base}/swarm/why?${query.toString()}`, { headers: this.headers })
    if (!res.ok) throw new Error(`swarm why: HTTP ${res.status}`)
    const body = (await res.json()) as { data?: { entries: Array<{ file: string; agentID: string; role?: string; state: string; taskID?: string; artifacts: string[]; workspacePath?: string }> } }
    const entries = body.data?.entries ?? []
    if (entries.length === 0) return `no provenance found for ${target}`
    const lines = [`/why ${target}`, ""]
    for (const e of entries) {
      lines.push(`file: ${e.file}`)
      lines.push(`agent: ${e.agentID} (${e.role ?? "agent"}) — ${e.state}`)
      if (e.taskID) lines.push(`task: ${e.taskID}`)
      if (e.artifacts.length > 0) lines.push(`artifacts: ${e.artifacts.join(", ")}`)
      if (e.workspacePath) lines.push(`workspace: ${e.workspacePath}`)
      lines.push("")
    }
    return lines.join("\n")
  }

  private endpoint(path: string): string {
    const base = this.url.replace(/\/+$/, "")
    const dir = this.directory
    const query = dir !== undefined && dir !== "" ? `?directory=${encodeURIComponent(dir)}` : ""
    return `${base}${path}${query}`
  }

  // ---------------------------------------------------------------------
  // Mutation surface. These call REAL server endpoints (/swarm/pause,
  // /swarm/resume, /swarm/cancel). Each performs a validated state transition
  // server-side and emits audit state; the overlay refreshes afterwards. The
  // approval/emergency/budget mutations still lack a server endpoint and are
  // reported honestly rather than faked.
  // ---------------------------------------------------------------------

  private async post(path: string, body?: unknown): Promise<void> {
    const res = await this.fetch(this.endpoint(path), {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
    this.onMutate?.()
    await this.tick()
  }

  pause(): void {
    void this.post("/swarm/pause").catch((e) => {
      this.errorValue = e instanceof Error ? e.message : String(e)
    })
  }

  resume(): void {
    void this.post("/swarm/resume").catch((e) => {
      this.errorValue = e instanceof Error ? e.message : String(e)
    })
  }

  cancelAgent(agentID: string): void {
    void this.post("/swarm/cancel", { agentID, branch: false }).catch((e) => {
      this.errorValue = e instanceof Error ? e.message : String(e)
    })
  }

  cancelBranch(agentID: string): void {
    void this.post("/swarm/cancel", { agentID, branch: true }).catch((e) => {
      this.errorValue = e instanceof Error ? e.message : String(e)
    })
  }

  private unsupported(name: string): never {
    throw new Error(`${name} is not available yet: no server mutation endpoint exists`)
  }

  approveOnce(): void {
    // Integration approval is raised via /swarm/integration/approve. The
    // overlay calls completeIntegration() with the summary; route it there.
    void this.post("/swarm/integration/approve", {
      summary: "user approved swarm integration",
      changedFiles: [],
      sessionID: "",
    }).catch((e) => {
      this.errorValue = e instanceof Error ? e.message : String(e)
    })
  }
  approveScope(): void { this.unsupported("approveScope") }
  reject(): void { this.unsupported("reject") }
  resolveBudgetIncrease(): void { this.unsupported("resolveBudgetIncrease") }
  emergencyStop(): void { this.unsupported("emergencyStop") }
  resumeFromStop(): void { this.unsupported("resumeFromStop") }
  setActiveBound(): void { this.unsupported("setActiveBound") }
  setMissionBudgetLimits(): void { this.unsupported("setMissionBudgetLimits") }
  disableModel(): void { this.unsupported("disableModel") }
  injectMessage(): void { this.unsupported("injectMessage") }
  completeIntegration(): void {
    void this.post("/swarm/integration/apply").catch((e) => {
      this.errorValue = e instanceof Error ? e.message : String(e)
    })
  }
  isEmergencyStopped(): boolean { return false }

  dispose(): void {
    // No timers owned here; the provider owns the polling interval.
  }
}