import { describe, expect, test } from "bun:test"
import { SwarmConfig } from "../src/config/config"
import { SwarmModelCatalog } from "../src/models/catalog"
import { SwarmModelHealth } from "../src/models/health"
import { SwarmModelRouter } from "../src/router/router"

// Routing fixtures: three allowed models across two pools.
const ALLOWED = ["fake/cheap", "fake/opus", "fake/flash", "fake/vision"]

function baseConfig(): SwarmConfig.Info {
  return {
    enabled: true,
    max_agents: 100,
    max_active_agents: 8,
    max_active_coding_workspaces: 4,
    max_depth: 4,
    max_children_per_agent: 20,
    models: {
      allowed: ALLOWED,
      pools: {
        cheap: ["fake/cheap", "fake/flash"],
        coding: ["fake/flash", "fake/opus"],
        review: ["fake/flash"],
      },
      catalog: {
        "fake/cheap": { priority: 1, latency_ms: 40, context_window: 8000, capabilities: { tools: true } },
        "fake/flash": { priority: 2, latency_ms: 20, context_window: 16000, capabilities: { tools: true } },
        "fake/opus": { priority: 5, latency_ms: 200, context_window: 200000, capabilities: { tools: true, reasoning: true } },
        "fake/vision": { priority: 4, latency_ms: 100, context_window: 128000, capabilities: { vision: true } },
      },
      routing: { policy: "prefer-cheapest" },
      limits: undefined,
      providers: undefined,
      global_concurrency: undefined,
      mission_token_budget: undefined,
    },
    approval: {
      spawn: "allow",
      workspace_write: "allow",
      dependency_change: "ask",
      git_commit: "ask",
      git_push: "ask",
      merge: "ask",
      external_side_effect: "ask",
      mission_plan: "ask",
      integration: "ask",
      budget_increase: "ask",
    },
    budget: { default: undefined, soft_ratio: 0.8 },
  }
}

function context(policy: SwarmConfig.RoutingPolicy, health = SwarmModelHealth.emptyHealthState(), now = 1_700_000_000_000): SwarmModelRouter.RoutingContext {
  return {
    policy,
    catalog: SwarmModelCatalog.buildCatalog(baseConfig()),
    pools: baseConfig().models.pools,
    health,
    now,
    concurrency: new Map(),
    providerConcurrency: new Map(),
    limits: undefined,
    providerLimits: undefined,
  }
}

describe("SwarmModelRouter.policy", () => {
  test("prefer-cheapest selects the cheapest eligible model in the pool", () => {
    const r = SwarmModelRouter.route(context("prefer-cheapest"), { requestedPool: "cheap" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.model).toBe("fake/cheap")
  })

  test("prefer-lowest-latency selects the fastest eligible model", () => {
    const r = SwarmModelRouter.route(context("prefer-lowest-latency"), { requestedPool: "cheap" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.model).toBe("fake/flash")
  })

  test("prefer-strongest selects the strongest eligible model", () => {
    const r = SwarmModelRouter.route(context("prefer-strongest"), { requestedPool: "coding" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.model).toBe("fake/opus")
  })

  test("balanced spreads load: least-loaded model wins under equal load", () => {
    const base = baseConfig()
    const ctx: SwarmModelRouter.RoutingContext = {
      policy: "balanced",
      catalog: SwarmModelCatalog.buildCatalog(base),
      pools: base.models.pools,
      health: SwarmModelHealth.emptyHealthState(),
      now: 1,
      concurrency: new Map([["fake/cheap", 3], ["fake/flash", 0]]),
      providerConcurrency: new Map(),
      limits: undefined,
      providerLimits: undefined,
    }
    const r = SwarmModelRouter.route(ctx, { requestedPool: "cheap" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.model).toBe("fake/flash")
  })

  test("explicit-only requires an explicit request and never falls back", () => {
    const noRequest = SwarmModelRouter.route(context("explicit-only"), { requestedPool: "cheap" })
    expect(noRequest.ok).toBe(false)
    if (!noRequest.ok) expect(noRequest.code).toBe("policy_requires_explicit")

    const explicit = SwarmModelRouter.route(context("explicit-only"), { requestedModel: "fake/cheap" })
    expect(explicit.ok).toBe(true)
    if (explicit.ok) expect(explicit.model).toBe("fake/cheap")

    const denied = SwarmModelRouter.route(context("explicit-only"), { requestedModel: "fake/not-allowed" })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.code).toBe("model_not_allowed")
  })

  test("explicit-only never substitutes a rate-limited explicit model", () => {
    const health = SwarmModelHealth.emptyHealthState()
    SwarmModelHealth.markHealth(health, "fake/cheap", "rate_limited", 1_700_000_000_000, 10_000)
    const r = SwarmModelRouter.route(context("explicit-only", health), { requestedModel: "fake/cheap" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("rate_limited")
  })
})

describe("SwarmModelRouter.pools (fail-closed)", () => {
  test("unknown pool is rejected", () => {
    const r = SwarmModelRouter.route(context("prefer-cheapest"), { requestedPool: "nope" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("pool_not_found")
  })

  test("a pool with no human-authorized members is empty (never auto-added)", () => {
    // A pool referencing unlisted models (and one removed from the allowlist)
    // has zero authorized members -> empty, never auto-added.
    const config = { ...baseConfig(), models: { ...baseConfig().models, allowed: ["fake/cheap"], pools: { ghosts: ["fake/opus", "unlisted/model"] } } }
    const ctx: SwarmModelRouter.RoutingContext = {
      policy: "prefer-cheapest",
      catalog: SwarmModelCatalog.buildCatalog(config),
      pools: config.models.pools,
      health: SwarmModelHealth.emptyHealthState(),
      now: 1,
      concurrency: new Map(),
      providerConcurrency: new Map(),
      limits: undefined,
      providerLimits: undefined,
    }
    const r = SwarmModelRouter.route(ctx, { requestedPool: "ghosts" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("pool_empty")
  })

  test("empty allowlist grants no models (fail-closed)", () => {
    const config = { ...baseConfig(), models: { ...baseConfig().models, allowed: [] } }
    const ctx: SwarmModelRouter.RoutingContext = {
      policy: "prefer-cheapest",
      catalog: SwarmModelCatalog.buildCatalog(config),
      pools: config.models.pools,
      health: SwarmModelHealth.emptyHealthState(),
      now: 1,
      concurrency: new Map(),
      providerConcurrency: new Map(),
      limits: undefined,
      providerLimits: undefined,
    }
    const r = SwarmModelRouter.route(ctx, {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("no_models_allowed")
  })
})

describe("SwarmModelRouter.capability + context", () => {
  test("requesting vision narrows candidates to vision-capable models", () => {
    const r = SwarmModelRouter.route(context("prefer-cheapest"), { requestedCapability: "vision" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.model).toBe("fake/vision")
  })

  test("requesting reasoning narrows candidates to reasoning-capable models", () => {
    const r = SwarmModelRouter.route(context("prefer-cheapest"), { requestedCapability: "reasoning" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.model).toBe("fake/opus")
  })

  test("a context size that exceeds every allowed model fails with context_overflow (never truncates)", () => {
    const r = SwarmModelRouter.route(context("prefer-cheapest"), { contextSize: 500_000 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe("context_overflow")
      expect(r.reason).toContain("no allowed model fits context 500000")
    }
  })

  test("a context size beyond small models selects a larger-context allowed model", () => {
    const r = SwarmModelRouter.route(context("prefer-strongest"), { contextSize: 100_000 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.model).toBe("fake/opus")
  })

  test("tools requirement filters models that do not declare tool support", () => {
    const ctx = context("prefer-cheapest")
    const r = SwarmModelRouter.route(ctx, { requestedPool: "cheap", requiresTools: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.model).toBe("fake/cheap")
  })
})

describe("SwarmModelRouter.health + fallback", () => {
  test("rate-limited primary falls back to the next authorized pool member", () => {
    const health = SwarmModelHealth.emptyHealthState()
    SwarmModelHealth.markHealth(health, "fake/cheap", "rate_limited", 1_700_000_000_000, 10_000)
    const r = SwarmModelRouter.route(context("prefer-cheapest", health), { requestedPool: "cheap" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.model).toBe("fake/flash")
      // The fallback order lists only authorized models.
      expect(r.fallbackOrder.every((m) => ALLOWED.includes(m))).toBe(true)
    }
  })

  test("fallback never bypasses the allowlist: a rate-limited pool with no other authorized member fails", () => {
    const health = SwarmModelHealth.emptyHealthState()
    SwarmModelHealth.markHealth(health, "fake/flash", "rate_limited", 1_700_000_000_000, 10_000)
    const ctx = context("prefer-cheapest", health)
    // Pool "review" only contains fake/flash — rate limited, no fallback.
    const r = SwarmModelRouter.route(ctx, { requestedPool: "review" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("rate_limited")
  })

  test("rate-limited model becomes usable again after its cooldown", () => {
    const health = SwarmModelHealth.emptyHealthState()
    const now = 1_700_000_000_000
    SwarmModelHealth.markHealth(health, "fake/cheap", "rate_limited", now, 5_000)
    expect(SwarmModelHealth.isUsable(health, "fake/cheap", now + 1)).toBe(false)
    expect(SwarmModelHealth.isUsable(health, "fake/cheap", now + 5_001)).toBe(true)
  })

  test("authentication failure disables the model: it is never selected, fallback stays authorized", () => {
    const health = SwarmModelHealth.emptyHealthState()
    SwarmModelHealth.markHealth(health, "fake/opus", "authentication_failure", 1)
    const ctx = context("prefer-cheapest", health)
    const r = SwarmModelRouter.route(ctx, { requestedModel: "fake/opus" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.model).not.toBe("fake/opus")
      expect(ALLOWED).toContain(r.model)
    }
  })

  test("requested authorized model falls back within the allowlist when rate-limited", () => {
    const health = SwarmModelHealth.emptyHealthState()
    SwarmModelHealth.markHealth(health, "fake/opus", "rate_limited", 1_700_000_000_000, 10_000)
    const r = SwarmModelRouter.route(context("prefer-cheapest", health), { requestedModel: "fake/opus" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.model).toBe("fake/cheap")
      expect(r.fallbackOrder.every((m) => ALLOWED.includes(m))).toBe(true)
    }
  })

  test("exhausted mission budget blocks routing entirely", () => {
    const r = SwarmModelRouter.route(context("prefer-cheapest"), { remainingBudget: { modelCalls: 0 } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("no_remaining_budget")
  })
})

describe("SwarmModelCatalog", () => {
  test("catalog contains only allowlisted models and derives provider from id", () => {
    const models = SwarmModelCatalog.buildCatalog(baseConfig())
    expect(models.length).toBe(ALLOWED.length)
    for (const m of models) {
      expect(m.enabled).toBe(true)
      expect(m.provider).toBe("fake")
    }
  })

  test("a model in catalog metadata but not allowed never appears (fail-closed)", () => {
    const config = { ...baseConfig(), models: { ...baseConfig().models, catalog: { "unlisted/model": { context_window: 1000 } } } }
    const models = SwarmModelCatalog.buildCatalog(config)
    expect(models.some((m) => m.id === "unlisted/model")).toBe(false)
  })
})
