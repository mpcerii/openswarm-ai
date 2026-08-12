import { describe, expect, test } from "bun:test"
import { SwarmAgent } from "../src/agent/agent"
import { SwarmProvider } from "../src/provider/provider"
import { SwarmClusterSim } from "../src/simulation/cluster-simulation"

describe("chaos: workers randomly terminate during a mission", () => {
  test("mission completes, no task disappears, no agent duplicates, population invariant holds, audit explains retries", async () => {
    const seed = 0xc0ffee
    const rand = SwarmClusterSim.seededRandom(seed)
    const population = 300
    const sim = await SwarmClusterSim.makeCluster({
      population,
      activeBound: 30,
      workspaceBound: 8,
      childrenPerAgent: 60,
      maxDepth: 4,
      workerCount: 8,
      maxConcurrentPerWorker: 8,
      llmCap: 64,
      leaseTimeoutMs: 80,
      heartbeatTimeoutMs: 160,
      clockStepMs: 10,
      provider: () => SwarmProvider.echoProvider(),
      seed,
    })

    // Deterministic chaos driver: each round, with probability p, a random
    // live worker "dies" (stops heartbeating and claims entirely).
    const alive = new Set(sim.workers)
    let terminations = 0
    let rounds = 0
    while (rounds < 3000) {
      rounds++
      sim.clock.step()
      if (alive.size > 2 && rand() < 0.12) {
        const victims = [...alive]
        const victim = victims[Math.floor(rand() * victims.length)]!
        await victim.terminate()
        alive.delete(victim)
        terminations++
      }
      await sim.control.tick()
      for (const worker of sim.workers) {
        if (!worker.terminated) await worker.pump()
      }
      if (await SwarmClusterSim.isMissionDone(sim)) break
    }

    const agents = await sim.store.listAgents()
    const nonPrimary = agents.filter((a) => a.id !== sim.primaryID)
    const accounting = await sim.store.accounting()

    // At least one worker really did die mid-mission.
    expect(terminations).toBeGreaterThanOrEqual(1)
    // Every logical agent reaches a terminal state — no task is lost forever.
    for (const a of nonPrimary) {
      expect(SwarmAgent.isDone(a.state)).toBe(true)
    }
    expect(rounds).toBeLessThan(3000)
    // No logical agent is duplicated: exactly the spawned population exists.
    expect(nonPrimary.length).toBe(population - 1)
    expect(new Set(nonPrimary.map((a) => a.id)).size).toBe(population - 1)
    // Population invariant: never exceeded, still fully accounted.
    expect(accounting.population).toBe(population - 1)
    expect(accounting.population).toBeLessThanOrEqual(sim.control.config.max_agents)
    // Global active bound held through the chaos.
    expect(accounting.activeAgentsPeak).toBeLessThanOrEqual(sim.control.config.max_active_agents)
    // Audit explains the retries: lease expiry + agent requeue are recorded.
    const expired = await sim.store.eventsByType("swarm.lease.expired")
    const requeued = await sim.store.eventsByType("swarm.agent.requeued")
    expect(expired.length).toBeGreaterThanOrEqual(terminations)
    expect(requeued.length).toBeGreaterThanOrEqual(terminations)
    // Workers that died are detected offline once their heartbeat times out
    // (the final victim may complete the mission before its timeout elapses).
    const workers = await sim.store.listWorkers()
    const offline = workers.filter((w) => w.health === "offline").length
    expect(offline).toBeGreaterThanOrEqual(1)
    expect(offline).toBeLessThanOrEqual(terminations)
  }, 120_000)
})
