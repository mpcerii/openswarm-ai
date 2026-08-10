import { describe, expect, test } from "bun:test"
import { SwarmBudget } from "../src/policy/budget"
import { SwarmModels } from "../src/models/policy"

const limits: SwarmBudget.Limits = {
  max_agents: 10,
  max_active_agents: 2,
  max_depth: 2,
  max_children_per_agent: 3,
}

describe("SwarmModels.resolve", () => {
  test("empty allowlist grants no models (fail-closed)", () => {
    expect(SwarmModels.resolve({ allowed: [] })).toEqual({ ok: false, code: "no_models_allowed" })
    expect(SwarmModels.resolve({ allowed: [] }, "anthropic/claude-sonnet-4")).toEqual({
      ok: false,
      code: "no_models_allowed",
    })
  })

  test("requested model must appear exactly in the allowlist", () => {
    const policy = { allowed: ["anthropic/claude-sonnet-4"] }
    expect(SwarmModels.resolve(policy, "anthropic/claude-sonnet-4")).toEqual({
      ok: true,
      model: "anthropic/claude-sonnet-4",
    })
    expect(SwarmModels.resolve(policy, "anthropic/claude-opus")).toEqual({ ok: false, code: "model_not_allowed" })
    expect(SwarmModels.resolve(policy, " anthropic/claude-sonnet-4")).toEqual({
      ok: false,
      code: "model_not_allowed",
    })
  })

  test("without a request the first allowed model is the deterministic default", () => {
    expect(SwarmModels.resolve({ allowed: ["openai/gpt-5", "anthropic/claude-sonnet-4"] })).toEqual({
      ok: true,
      model: "openai/gpt-5",
    })
  })
})

describe("SwarmBudget.evaluateSpawn", () => {
  test("admits within budget and reports child depth", () => {
    expect(SwarmBudget.evaluateSpawn(limits, { population: 0 })).toEqual({ ok: true, depth: 1 })
    expect(SwarmBudget.evaluateSpawn(limits, { population: 5, parentDepth: 1 })).toEqual({ ok: true, depth: 2 })
  })

  test("rejects when population budget is exhausted", () => {
    expect(SwarmBudget.evaluateSpawn(limits, { population: 10 })).toEqual({
      ok: false,
      code: "population_exceeded",
    })
    expect(SwarmBudget.evaluateSpawn(limits, { population: 9 }, 2)).toEqual({
      ok: false,
      code: "population_exceeded",
    })
  })

  test("rejects beyond max depth", () => {
    expect(SwarmBudget.evaluateSpawn(limits, { population: 1, parentDepth: 2 })).toEqual({
      ok: false,
      code: "depth_exceeded",
    })
  })

  test("rejects beyond children-per-agent", () => {
    expect(SwarmBudget.evaluateSpawn(limits, { population: 1, parentChildren: 3 })).toEqual({
      ok: false,
      code: "children_exceeded",
    })
    expect(SwarmBudget.evaluateSpawn(limits, { population: 1, parentChildren: 2 }, 2)).toEqual({
      ok: false,
      code: "children_exceeded",
    })
  })
})

describe("SwarmBudget.canAdmit", () => {
  test("bounds concurrent execution", () => {
    expect(SwarmBudget.canAdmit(limits, 0)).toBe(true)
    expect(SwarmBudget.canAdmit(limits, 1)).toBe(true)
    expect(SwarmBudget.canAdmit(limits, 2)).toBe(false)
  })
})
