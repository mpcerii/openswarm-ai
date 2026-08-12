import { describe, expect, test } from "bun:test"
import { SwarmAgent } from "../src/agent/agent"
import { SwarmArtifact } from "../src/artifacts/artifact"
import { SwarmWorker } from "../src/cluster/worker"
import { SwarmCredentials } from "../src/cluster/credentials"
import { SwarmLease } from "../src/cluster/lease"
import { SwarmProvider } from "../src/provider/provider"
import { MemoryStore } from "../src/storage/memory"
import { ControlPlane } from "../src/control/control"
import { WorkerNode } from "../src/worker/node"
import { SwarmClusterSim } from "../src/simulation/cluster-simulation"

const tiny = (overrides: Partial<SwarmClusterSim.ClusterSimOptions> = {}): SwarmClusterSim.ClusterSimOptions => ({
  population: 20,
  activeBound: 4,
  workspaceBound: 2,
  childrenPerAgent: 50,
  maxDepth: 3,
  workerCount: 2,
  maxConcurrentPerWorker: 2,
  llmCap: 8,
  clockStepMs: 5,
  ...overrides,
})

describe("cluster: worker registration & security", () => {
  test("workers register with credentials; anonymous workers are rejected", async () => {
    const store = new MemoryStore({ max_agents: 100, max_active_agents: 4, max_depth: 3, max_children_per_agent: 10 }, 8, 2)
    const control = new ControlPlane({ store, config: SwarmClusterSim.defaultClusterConfig(tiny()), now: () => 1 })
    const workerID = SwarmWorker.ID.create()
    const issued = await control.issueCredential({
      workerID,
      name: "w1",
      scopes: { capabilities: [], providers: ["fake"], models: [], platforms: [] },
    })
    const ok = await control.register(
      {
        workerID,
        name: "w1",
        capabilities: workerCaps(workerID),
        credentialID: issued.credential.id,
      },
      issued.secret,
      1,
    )
    expect(ok.accepted).toBe(true)

    const anon = await control.register({ workerID: SwarmWorker.ID.create(), name: "anon", capabilities: workerCaps(SwarmWorker.ID.create()) }, "whatever", 1)
    expect(anon.accepted).toBe(false)

    const badSecret = await control.register(
      { workerID: SwarmWorker.ID.create(), name: "w2", capabilities: workerCaps(SwarmWorker.ID.create()), credentialID: issued.credential.id },
      "wrong-secret",
      1,
    )
    expect(badSecret.accepted).toBe(false)

    await control.revokeCredential(issued.credential.id)
    const afterRevoke = await control.register(
      { workerID, name: "w1", capabilities: workerCaps(workerID), credentialID: issued.credential.id },
      issued.secret,
      2,
    )
    expect(afterRevoke.accepted).toBe(false)
  })

  test("credential scopes restrict capabilities and models (intersection, never broadening)", async () => {
    const store = new MemoryStore({ max_agents: 100, max_active_agents: 4, max_depth: 3, max_children_per_agent: 10 }, 8, 2)
    const control = new ControlPlane({ store, config: SwarmClusterSim.defaultClusterConfig(tiny()), now: () => 1 })
    const workerID = SwarmWorker.ID.create()
    const issued = await control.issueCredential({
      workerID,
      name: "restricted",
      scopes: { capabilities: ["review"], providers: ["fake"], models: ["fake/echo"], platforms: [] },
    })
    const res = await control.register(
      {
        workerID,
        name: "restricted",
        capabilities: { ...workerCaps(workerID), capabilities: ["coding-workspace", "review", "docker"] },
        credentialID: issued.credential.id,
      },
      issued.secret,
      1,
    )
    expect(res.accepted).toBe(true)
    const worker = await store.getWorker(workerID)
    expect(worker?.capabilities.capabilities).toEqual(["review"])
    expect(worker?.capabilities.availableModels).toEqual(["fake/echo"])
  })

  test("secrets are scoped: a worker without a grant cannot read a project secret", async () => {
    const store = new MemoryStore({ max_agents: 100, max_active_agents: 4, max_depth: 3, max_children_per_agent: 10 }, 8, 2)
    const control = new ControlPlane({ store, config: SwarmClusterSim.defaultClusterConfig(tiny()), now: () => 1 })
    const workerID = SwarmWorker.ID.create()
    const issued = await control.issueCredential({
      workerID,
      name: "w1",
      scopes: { capabilities: [], providers: ["anthropic"], models: [], platforms: [] },
    })
    await control.register(
      { workerID, name: "w1", capabilities: workerCaps(workerID), credentialID: issued.credential.id },
      issued.secret,
      1,
    )
    await control.putSecret({ ref: "provider:anthropic/api_key", value: "sk-abc123", scope: "provider:anthropic" })
    const agentID = SwarmAgent.ID.create()
    const denied = await control.resolveSecret(workerID, agentID, "provider:anthropic/api_key")
    expect(denied).toMatchObject({ denied: expect.any(String) })

    // Grant the secret to this agent only; now the worker may resolve it.
    await control.grantSecret({ agentID, ref: "provider:anthropic/api_key" })
    const granted = await control.resolveSecret(workerID, agentID, "provider:anthropic/api_key")
    expect(granted).toEqual({ value: "sk-abc123" })

    // But a credential without the provider scope still cannot.
    const other = SwarmWorker.ID.create()
    const otherIssued = await control.issueCredential({
      workerID: other,
      name: "no-anthropic",
      scopes: { capabilities: [], providers: ["openai"], models: [], platforms: [] },
    })
    await control.register({ workerID: other, name: "no-anthropic", capabilities: workerCaps(other), credentialID: otherIssued.credential.id }, otherIssued.secret, 1)
    const otherDenied = await control.resolveSecret(other, agentID, "provider:anthropic/api_key")
    expect(otherDenied).toMatchObject({ denied: expect.any(String) })
  })
})

describe("cluster: work leasing", () => {
  test("a lease can be claimed, extended, and completed; only the holder may complete it", async () => {
    const store = new MemoryStore({ max_agents: 100, max_active_agents: 4, max_depth: 3, max_children_per_agent: 10 }, 8, 2)
    const control = new ControlPlane({ store, config: SwarmClusterSim.defaultClusterConfig(tiny()), leaseTimeoutMs: 1000, now: () => 1 })
    const w1 = SwarmWorker.ID.create()
    const issued1 = await control.issueCredential({ workerID: w1, name: "w1", scopes: emptyScopes() })
    await control.register({ workerID: w1, name: "w1", capabilities: workerCaps(w1), credentialID: issued1.credential.id }, issued1.secret, 1)
    const w2 = SwarmWorker.ID.create()
    const issued2 = await control.issueCredential({ workerID: w2, name: "w2", scopes: emptyScopes() })
    await control.register({ workerID: w2, name: "w2", capabilities: workerCaps(w2), credentialID: issued2.credential.id }, issued2.secret, 1)

    const primaryID = SwarmAgent.ID.create()
    const mission = await control.createMission({ title: "m", brief: "b", primaryAgentID: primaryID })
    await control.registerPrimary({ missionID: mission.id, agentID: primaryID })
    const spawn = await control.spawn(primaryID, { missionID: mission.id, role: "investigator" })
    expect(spawn.type).toBe("spawned")

    await control.tick()
    const leases = await store.listLeases()
    expect(leases.length).toBe(1)
    const lease = leases[0]!
    expect(lease.status).toBe("pending")

    const claimed = await control.claimLease(w1, 10)
    expect(claimed).toBeDefined()
    expect(claimed!.worker_id).toBe(w1)
    expect((await store.getAgent(lease.agent_id))?.state).toBe("running")

    // Another worker cannot steal the lease.
    const stolen = await control.claimLease(w2, 20)
    expect(stolen).toBeUndefined()

    const extended = await control.extendLease(w1, lease.id, 5000, 30)
    expect(extended).toBe(true)

    const foreignAck = await control.ackLease(w2, lease.id, { state: "completed" }, 40)
    expect(foreignAck.ok).toBe(false)

    const ack = await control.ackLease(w1, lease.id, { state: "completed" }, 50)
    expect(ack.ok).toBe(true)
    if (ack.ok) {
      expect(ack.lease.status).toBe("completed")
      expect((await store.getAgent(lease.agent_id))?.state).toBe("completed")
    }
  })

  test("an unacked lease expires and the agent is requeued, not failed", async () => {
    const store = new MemoryStore({ max_agents: 100, max_active_agents: 4, max_depth: 3, max_children_per_agent: 10 }, 8, 2)
    const control = new ControlPlane({ store, config: SwarmClusterSim.defaultClusterConfig(tiny()), leaseTimeoutMs: 100, heartbeatTimeoutMs: 200, now: () => 0 })
    const w1 = SwarmWorker.ID.create()
    const issued1 = await control.issueCredential({ workerID: w1, name: "w1", scopes: emptyScopes() })
    await control.register({ workerID: w1, name: "w1", capabilities: workerCaps(w1), credentialID: issued1.credential.id }, issued1.secret, 0)

    const primaryID = SwarmAgent.ID.create()
    const mission = await control.createMission({ title: "m", brief: "b", primaryAgentID: primaryID })
    await control.registerPrimary({ missionID: mission.id, agentID: primaryID })
    const spawn = await control.spawn(primaryID, { missionID: mission.id, role: "investigator" })
    expect(spawn.type).toBe("spawned")
    const agentID = spawn.type === "spawned" ? spawn.agents[0]! : ""

    await control.tick()
    const lease = (await store.listLeases())[0]!
    await control.claimLease(w1, 10)

    // Advance far past the lease timeout, then sweep: the lease expires and
    // the agent is requeued (waiting -> queued), not marked failed.
    await control.sweepLeases(500)
    const expired = await store.getLease(lease.id)
    expect(expired?.status).toBe("expired")
    const agent = await store.getAgent(agentID)
    expect(agent?.state).toBe("queued")
  })

  test("duplicate delivery cannot double-execute: only the first claim wins", async () => {
    const store = new MemoryStore({ max_agents: 100, max_active_agents: 4, max_depth: 3, max_children_per_agent: 10 }, 8, 2)
    const control = new ControlPlane({ store, config: SwarmClusterSim.defaultClusterConfig(tiny()), now: () => 0 })
    const w1 = SwarmWorker.ID.create()
    const issued1 = await control.issueCredential({ workerID: w1, name: "w1", scopes: emptyScopes() })
    await control.register({ workerID: w1, name: "w1", capabilities: workerCaps(w1), credentialID: issued1.credential.id }, issued1.secret, 0)

    const primaryID = SwarmAgent.ID.create()
    const mission = await control.createMission({ title: "m", brief: "b", primaryAgentID: primaryID })
    await control.registerPrimary({ missionID: mission.id, agentID: primaryID })
    await control.spawn(primaryID, { missionID: mission.id, role: "investigator" })
    await control.tick()
    const lease = (await store.listLeases())[0]!

    // Simulate a duplicate delivery: publish the same lease id twice.
    await store.queue.publish({ id: `dup_${lease.id}`, kind: `lease:${w1}`, payload: lease.id, visibleAt: 0, createdAt: 0 })

    const first = await control.claimLease(w1, 5)
    expect(first?.id).toBe(lease.id)
    // Second claim sees the lease already claimed -> drops the duplicate.
    const second = await control.claimLease(w1, 6)
    expect(second).toBeUndefined()
    const l = await store.getLease(lease.id)
    expect(l?.status).toBe("claimed")
  })
})

describe("cluster: distributed execution", () => {
  test("small mission completes across workers (no LLM)", async () => {
    const sim = await SwarmClusterSim.runClusterSim(tiny())
    const agents = await sim.store.listAgents()
    const nonPrimary = agents.filter((a) => a.id !== sim.primaryID)
    expect(nonPrimary.length).toBeGreaterThanOrEqual(1)
    for (const a of nonPrimary) {
      expect(SwarmAgent.isDone(a.state)).toBe(true)
    }
    expect((await sim.store.accounting()).activeAgents).toBe(0)
  })

  test("agents are distributed across workers (scheduler fairness)", async () => {
    const sim = await SwarmClusterSim.runClusterSim(tiny({ population: 120, activeBound: 8, workerCount: 4, maxConcurrentPerWorker: 4, llmCap: 16 }))
    const leases = await sim.store.listLeases()
    const byWorker = new Map<string, number>()
    for (const l of leases) {
      if (l.worker_id !== null) byWorker.set(l.worker_id, (byWorker.get(l.worker_id) ?? 0) + 1)
    }
    expect(byWorker.size).toBeGreaterThanOrEqual(3)
    const counts = [...byWorker.values()].sort((a, b) => b - a)
    // Least-loaded routing keeps the busiest worker from running away with the
    // whole population.
    expect(counts[0]!).toBeLessThanOrEqual(byWorker.size * 6 + 10)
  })

  test("capability-based routing: agents requiring an unserved capability stay queued", async () => {
    const sim = await SwarmClusterSim.makeCluster(tiny({ population: 30, workerCount: 2, maxConcurrentPerWorker: 4, activeBound: 8 }))
    const mission = (await sim.store.listMissions())[0]!
    const primaryID = sim.primaryID
    const capped = await sim.control.spawn(primaryID, { missionID: mission.id, role: "docker-only", capability: "docker" })
    const normal = await sim.control.spawn(primaryID, { missionID: mission.id, role: "plain" })
    expect(capped.type).toBe("spawned")
    expect(normal.type).toBe("spawned")
    await SwarmClusterSim.driveToFixedPoint(sim)
    // No worker advertises "docker", so the docker-only agent can never run.
    const dockerAgent = await sim.store.getAgent(capped.type === "spawned" ? capped.agents[0]! : "")
    expect(dockerAgent?.state).toBe("queued")
    // Unrestricted agents complete.
    const plain = await sim.store.getAgent(normal.type === "spawned" ? normal.agents[0]! : "")
    expect(SwarmAgent.isDone(plain!.state)).toBe(true)
  })

  test("idempotent execution: a retried run does not duplicate artifacts", async () => {
    const provider = SwarmProvider.makeFakeProvider({
      behaviorsByRole: new Map([
        [
          "implementer",
          (req, step) =>
            step === 0
              ? [{ toolCalls: [{ tool: "write_patch", args: { changedFiles: ["packages/code/main.ts"], diff: "@@", reason: "fix", tests: ["t"] } }] }]
              : [{ finish: "stop" }],
        ],
      ]),
      fallback: () => [{ finish: "stop" }],
    })
    const sim = await SwarmClusterSim.makeCluster(
      tiny({
        population: 5,
        workerCount: 1,
        maxConcurrentPerWorker: 2,
        activeBound: 2,
        provider: () => provider,
        leaseTimeoutMs: 100,
        clockStepMs: 5,
      }),
    )
    const mission = (await sim.store.listMissions())[0]!
    const sp = await sim.control.spawn(sim.primaryID, { missionID: mission.id, role: "implementer" })
    const agentID = sp.type === "spawned" ? sp.agents[0]! : ""
    await SwarmClusterSim.driveToFixedPoint(sim)
    const artifacts = (await sim.store.listArtifacts()).filter((a) => a.artifact.agentID === agentID)
    // Even with retries, the patch is created exactly once.
    expect(artifacts.length).toBe(1)
    expect(provider.historicCalls.length).toBeGreaterThanOrEqual(1)
  })

  test("worker crash: the agent resumes on another worker without permanent failure", async () => {
    const sim = await SwarmClusterSim.makeCluster(
      tiny({ population: 40, workerCount: 3, maxConcurrentPerWorker: 4, activeBound: 6, leaseTimeoutMs: 100, heartbeatTimeoutMs: 150, clockStepMs: 20 }),
    )
    // Let some work flow, then kill the busiest worker.
    await sim.control.tick()
    for (const w of sim.workers) await w.pump()
    const dead = sim.workers[1]!
    await dead.terminate()
    await SwarmClusterSim.driveToFixedPoint(sim, 500)
    const agents = await sim.store.listAgents()
    const nonPrimary = agents.filter((a) => a.id !== sim.primaryID)
    const completed = nonPrimary.filter((a) => a.state === "completed").length
    const failed = nonPrimary.filter((a) => a.state === "failed").length
    // The whole population still completes; workers vanishing never marks
    // agents failed — lease expiry requeues them.
    expect(completed).toBe(nonPrimary.length)
    expect(failed).toBe(0)
    // Audit explains the retries via lease expiry + requeue.
    const expired = await sim.store.eventsByType("swarm.lease.expired")
    const requeued = await sim.store.eventsByType("swarm.agent.requeued")
    expect(expired.length).toBeGreaterThanOrEqual(1)
    expect(requeued.length).toBeGreaterThanOrEqual(1)
  })

  test("worker reconnect: a worker that re-registers keeps serving", async () => {
    const sim = await SwarmClusterSim.makeCluster(tiny({ population: 60, workerCount: 2, maxConcurrentPerWorker: 4, activeBound: 6, leaseTimeoutMs: 80, heartbeatTimeoutMs: 120, clockStepMs: 15 }))
    await sim.control.tick()
    for (const w of sim.workers) await w.pump()
    const offline = sim.workers[0]!
    await offline.terminate()
    await sim.control.sweepWorkers(300)
    // The worker comes back: re-registers and re-claims.
    const back = await offline.register(400)
    expect(back).toBe(true)
    await SwarmClusterSim.driveToFixedPoint(sim, 500)
    const agents = await sim.store.listAgents()
    const nonPrimary = agents.filter((a) => a.id !== sim.primaryID)
    for (const a of nonPrimary) expect(SwarmAgent.isDone(a.state)).toBe(true)
  })

  test("agent identity and durable state are independent of the executing worker", async () => {
    const sim = await SwarmClusterSim.makeCluster(tiny({ population: 12, workerCount: 2, maxConcurrentPerWorker: 2, activeBound: 2, leaseTimeoutMs: 60, heartbeatTimeoutMs: 100, clockStepMs: 8 }))
    // Issue leases, then kill worker0 before it ever claims: its pending leases
    // must expire and the agents must complete on worker1 with the SAME ids.
    await sim.control.tick()
    const dead = sim.workers[0]!
    const pending = (await sim.store.listLeases()).filter((l) => l.worker_id === dead.id && l.status === "pending")
    expect(pending.length).toBeGreaterThanOrEqual(1)
    await dead.terminate()
    await SwarmClusterSim.driveToFixedPoint(sim, 400)
    for (const lease of pending) {
      const agent = await sim.store.getAgent(lease.agent_id)
      expect(agent?.state).toBe("completed")
      const completing = (await sim.store.listLeases()).find((l) => l.agent_id === lease.agent_id && l.status === "completed")
      expect(completing?.worker_id).not.toBe(dead.id)
      // Exactly one durable record per logical agent — no duplicates.
      const count = (await sim.store.listAgents()).filter((a) => a.id === lease.agent_id).length
      expect(count).toBe(1)
    }
  })
})

describe("cluster: observability", () => {
  test("metrics expose connected workers, utilization, queue depth, and limits", async () => {
    const sim = await SwarmClusterSim.makeCluster(tiny({ population: 30, workerCount: 3, maxConcurrentPerWorker: 4, activeBound: 6, clockStepMs: 5 }))
    // Leases issued but not yet claimed -> in-flight work is visible.
    await sim.control.tick()
    const issued = await sim.control.metrics()
    expect(issued.connectedWorkers).toBe(3)
    expect(issued.utilization.length).toBe(3)
    expect(issued.leasedTasks).toBeGreaterThan(0)
    for (const w of sim.workers) await w.pump()
    await SwarmClusterSim.driveToFixedPoint(sim)
    const end = await sim.control.metrics()
    expect(end.globalActiveAgents).toBe(0)
    expect(end.globalActiveLLM).toBe(0)
    // Agent work is attributable per worker across the cluster.
    const leases = await sim.store.listLeases()
    const assigned = new Set(leases.filter((l) => l.worker_id !== null).map((l) => l.worker_id))
    expect(assigned.size).toBeGreaterThanOrEqual(1)
  })
})

describe("cluster: draining", () => {
  test("a draining worker stops claiming, finishes current leases, and goes offline cleanly", async () => {
    const sim = await SwarmClusterSim.makeCluster(tiny({ population: 60, workerCount: 3, maxConcurrentPerWorker: 4, activeBound: 8, clockStepMs: 5 }))
    await sim.control.tick()
    for (const w of sim.workers) await w.pump()
    const draining = sim.workers[0]!
    const leasesBefore = (await sim.store.listLeases()).filter((l) => l.worker_id === draining.id).length
    await draining.drain()
    await sim.control.tick()
    // The scheduler refuses new leases for a draining worker (canRun excludes
    // draining), so its assigned lease count does not grow.
    const leasesAfter = (await sim.store.listLeases()).filter((l) => l.worker_id === draining.id).length
    expect(leasesAfter).toBeLessThanOrEqual(leasesBefore)
    // Continue driving until the drained worker finishes and goes offline.
    await SwarmClusterSim.driveToFixedPoint(sim)
    expect(draining.terminated).toBe(true)
    expect((await sim.store.getWorker(draining.id))?.health).toBe("offline")
    const agents = await sim.store.listAgents()
    for (const a of agents) {
      if (a.id !== sim.primaryID) expect(SwarmAgent.isDone(a.state)).toBe(true)
    }
  })
})

describe("cluster: global limits", () => {
  test("10k-agent cluster never exceeds the global active bound", async () => {
    const activeBound = 100
    const sim = await SwarmClusterSim.runClusterSim(
      tiny({ population: 10000, activeBound, workspaceBound: 16, childrenPerAgent: 50, maxDepth: 6, workerCount: 8, maxConcurrentPerWorker: 16, llmCap: 200, clockStepMs: 1 }),
    )
    const accounting = await sim.store.accounting()
    expect(accounting.activeAgentsPeak).toBeLessThanOrEqual(activeBound)
    expect(accounting.population).toBeLessThanOrEqual(10000)
    const agents = await sim.store.listAgents()
    expect(agents.length).toBeLessThanOrEqual(10001)
  }, 120_000)

  test("population accounting is atomic: 10k target never over-spawns (e.g. 10,834)", async () => {
    const limits = { max_agents: 10000, max_active_agents: 100, max_depth: 6, max_children_per_agent: 100000 }
    const store = new MemoryStore(limits, 200, 16)
    const config = SwarmClusterSim.defaultClusterConfig({ population: 10000, activeBound: 100, workspaceBound: 16, childrenPerAgent: 100000, maxDepth: 6, workerCount: 8, maxConcurrentPerWorker: 16, llmCap: 200 })
    const control = new ControlPlane({ store, config, llmCap: 200, now: () => 1 })
    const primaryID = SwarmAgent.ID.create()
    const mission = await control.createMission({ title: "atomic", brief: "b", primaryAgentID: primaryID })
    await control.registerPrimary({ missionID: mission.id, agentID: primaryID })
    // 8 concurrent spawners attempt MORE than the population cap; the atomic
    // budget must admit exactly max_agents and reject the rest.
    const spawners = Array.from({ length: 8 }, () => SwarmAgent.ID.create())
    await Promise.all(
      spawners.map(async (spawner) => {
        for (let i = 0; i < 1500; i++) {
          await control.spawn(spawner, { missionID: mission.id, role: "echo" })
        }
      }),
    )
    const accounting = await store.accounting()
    expect(accounting.population).toBeLessThanOrEqual(10000)
    expect(accounting.population).toBe(10000)
  }, 60_000)

  test("global LLM concurrency never exceeds its cap", async () => {
    const llmCap = 3
    // A provider that holds its slot open long enough to contend.
    const delaying = (): SwarmProvider.Provider => ({
      async *stream() {
        yield { delta: "…", tokens: 1 }
        await Bun.sleep(1)
        yield { finish: "stop" }
      },
    })
    const sim = await SwarmClusterSim.runClusterSim(
      tiny({ population: 60, activeBound: 8, workerCount: 4, maxConcurrentPerWorker: 4, llmCap, provider: delaying, clockStepMs: 1 }),
    )
    const accounting = await sim.store.accounting()
    expect(accounting.activeLLMPeak).toBeLessThanOrEqual(llmCap)
  }, 60_000)
})

function emptyScopes(): SwarmCredentials.Scopes {
  return { capabilities: [], providers: ["fake"], models: [], platforms: [] }
}

function workerCaps(workerID: SwarmWorker.ID): SwarmWorker.Capabilities {
  return {
    workerID,
    maxConcurrentAgents: 4,
    maxConcurrentTools: 8,
    supportedPlatforms: ["linux", "win32"],
    capabilities: ["coding-workspace", "review"],
    availableModels: ["fake/echo"],
    git: true,
    shell: false,
    sandbox: true,
  }
}

