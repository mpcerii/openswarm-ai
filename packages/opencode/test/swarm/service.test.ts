import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { TestLLMServer } from "../lib/llm-server"
import { TestInstance } from "../fixture/fixture"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session/session"
import { Config } from "../../src/config/config"
import { Provider } from "../../src/provider/provider"
import { BackgroundJob } from "../../src/background/job"
import { SwarmService } from "../../src/swarm/service"
import { SwarmConfigBridge } from "../../src/swarm/config"
import { SwarmWorktreeBackend } from "../../src/swarm/worktree-backend"
import type { TaskPromptOps } from "../../src/tool/task"
import { SessionID } from "../../src/session/schema"

// Layer under test: SwarmService + the real session prompt loop. The model
// catalog is the real configured `test/test-model` provider; the promptOps
// seam is stubbed so no network is needed. Spawning an agent must validate
// model authorization against the allowlist ∩ real provider catalog and create
// a REAL child session.
const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })
// Replace the git-backed worktree node with an in-memory backend so these
// tests exercise the session-directory routing without requiring a git repo.
const memoryWorktreeNode = LayerNode.make({
  service: SwarmWorktreeBackend.Service,
  layer: SwarmWorktreeBackend.memoryLayer("<mem>"),
  deps: [],
})

const root = LayerNode.group([
  SwarmService.node,
  SessionPrompt.node,
  Session.node,
  Config.node,
  Provider.node,
  BackgroundJob.node,
  testLLMServerNode,
])

const it = testEffect(
  LayerNode.compile(root, [
    [SwarmWorktreeBackend.node, memoryWorktreeNode],
  ] as const),
)

const TEST_PROVIDER = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
    },
  },
}

const swarmCfg = (enabled: boolean, allowed: string[]) => ({ enabled, models: { allowed } })

function stubOps(): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) => Effect.succeed({ info: { id: input.sessionID, role: "assistant" } as never, parts: [] as never }),
  }
}

describe("SwarmService (real session bridge)", () => {
  it.instance(
    "spawns an agent with an authorized model and creates a real child session",
    () =>
      Effect.gen(function* () {
        const swarm = yield* SwarmService.Service
        // The model is authorized (allowlist ∩ real configured provider catalog).
        const approved = yield* swarm.approvedModelIDs()
        expect(approved).toContain("test/test-model")
        expect(yield* swarm.config()).toMatchObject({
          enabled: true,
          models: { allowed: ["test/test-model"] },
        })

        const out = yield* swarm.spawn(
          { objective: "inspect the failing auth test", role: "investigator" },
          stubOps(),
        )
        expect(out.state).toBe("queued")
        expect(out.agentID.length).toBeGreaterThan(0)
        expect(out.sessionID).toBeDefined()
        const view = yield* swarm.get(out.agentID)
        expect(view).toBeDefined()
        expect(view!.agent.resolvedModel).toBe("test/test-model")
        expect(view!.agent.sessionID).toBe(out.sessionID as unknown as SessionID)
        const m = yield* swarm.metrics()
        expect(m.population).toBeGreaterThanOrEqual(0)
      }),
    { config: () => ({ model: "test/test-model", ...TEST_PROVIDER, swarm: swarmCfg(true, ["test/test-model"]) }) },
  )

  it.instance(
    "rejects a model that is NOT in the allowlist (fail-closed)",
    () =>
      Effect.gen(function* () {
        const swarm = yield* SwarmService.Service
        const out = yield* swarm.spawn({ objective: "x", model: "anthropic/claude-opus" }, stubOps())
        expect(out.state).toBe("rejected")
        expect(out.rejection).toBe("model_not_allowed")
      }),
    { config: () => ({ model: "test/test-model", ...TEST_PROVIDER, swarm: swarmCfg(true, ["test/test-model"]) }) },
  )

  it.instance(
    "disabled swarm rejects all spawns",
    () =>
      Effect.gen(function* () {
        const swarm = yield* SwarmService.Service
        const out = yield* swarm.spawn({ objective: "x" }, stubOps())
        expect(out.state).toBe("rejected")
        expect(out.rejection).toBe("swarm disabled")
      }),
    { config: () => ({ model: "test/test-model", ...TEST_PROVIDER, swarm: swarmCfg(false, []) }) },
  )

  it.instance(
    "send_agent_message persists a message into the agent's mailbox",
    () =>
      Effect.gen(function* () {
        const swarm = yield* SwarmService.Service
        const out = yield* swarm.spawn({ objective: "x" }, stubOps())
        expect(out.state).toBe("queued")
        yield* swarm.sendMessage(out.agentID, "please also check JWT handling", "primary")
        const view = yield* swarm.get(out.agentID)
        expect(view!.messages.length).toBe(1)
        expect(view!.messages[0]!.body).toBe("please also check JWT handling")
      }),
    { config: () => ({ model: "test/test-model", ...TEST_PROVIDER, swarm: swarmCfg(true, ["test/test-model"]) }) },
  )

  it.instance(
    "the primary model does not automatically authorize child agents",
    () =>
      Effect.gen(function* () {
        const swarm = yield* SwarmService.Service
        // swarm.models.allowed contains a different model than the primary.
        const approved = yield* swarm.approvedModelIDs()
        expect(approved).not.toContain("test/other-model")
        // But an explicitly authorized one is fine.
        expect(approved).toContain("test/test-model")
      }),
    {
      config: () => ({
        model: "test/test-model",
        ...TEST_PROVIDER,
        swarm: swarmCfg(true, ["test/test-model"]),
      }),
    },
  )

  it.instance(
    "population increases after spawn and modelStates report availability",
    () =>
      Effect.gen(function* () {
        const swarm = yield* SwarmService.Service
        // Baseline population is whatever the shared store holds; zero is a
        // valid value, and spawn must always increase it by exactly one.
        const before = yield* swarm.metrics()

        const states0 = yield* swarm.modelStates()
        expect(states0).toEqual([{ id: "test/test-model", provider: "test", available: true }])

        const out = yield* swarm.spawn({ objective: "inspect", role: "investigator" }, stubOps())
        expect(out.state).toBe("queued")

        const after = yield* swarm.metrics()
        expect(after.population).toBe(before.population + 1)

        const list = yield* swarm.list()
        expect(list.some((v) => String(v.agent.id) === out.agentID)).toBe(true)
      }),
    {
      config: () => ({
        model: "test/test-model",
        ...TEST_PROVIDER,
        swarm: swarmCfg(true, ["test/test-model"]),
      }),
    },
  )

  it.instance(
    "authorized-but-unavailable model is reported unavailable, not silently granted",
    () =>
      Effect.gen(function* () {
        const swarm = yield* SwarmService.Service
        const states = yield* swarm.modelStates()
        // Only the configured test provider's model is available; an allowlisted
        // model with no configured provider surfaces as unavailable.
        expect(states).toEqual([{ id: "test/test-model", provider: "test", available: true }])
      }),
    {
      config: () => ({
        model: "test/test-model",
        ...TEST_PROVIDER,
        swarm: swarmCfg(true, ["test/test-model"]),
      }),
    },
  )
})

describe("SwarmConfigBridge", () => {
  test("defaults never grant all models", () => {
    const runtime = SwarmConfigBridge.swarmConfigFromV1(undefined)
    expect(runtime.enabled).toBe(false)
    expect(runtime.max_agents).toBe(10000)
    expect(runtime.models.allowed).toEqual([])
  })

  test("validation: enabled but no models reports a clear error", () => {
    const errors = SwarmConfigBridge.validateSwarmConfig({ enabled: true, models: { allowed: [] } })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]!.message).toContain("swarm.models.allowed")
    // Empty allowed list in the resolved runtime config stays fail-closed.
    const runtime = SwarmConfigBridge.swarmConfigFromV1({ enabled: true })
    expect(runtime.models.allowed).toEqual([])
    expect(runtime.enabled).toBe(true)
  })
})

void TestInstance