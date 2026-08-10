import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const decode = Schema.decodeUnknownSync(ConfigV1.Info)

describe("ConfigSwarmV1", () => {
  it.effect("decodes a complete swarm section", () =>
    Effect.sync(() => {
      const decoded = decode({
        swarm: {
          enabled: true,
          max_agents: 100,
          max_active_agents: 4,
          max_depth: 3,
          max_children_per_agent: 10,
          models: { allowed: ["anthropic/claude-sonnet-4", "openai/gpt-5"] },
          approval: {
            spawn: "allow",
            workspace_write: "allow",
            dependency_change: "ask",
            git_commit: "ask",
            git_push: "ask",
            merge: "deny",
            external_side_effect: "ask",
          },
        },
      })
      expect(decoded.swarm?.enabled).toBe(true)
      expect(decoded.swarm?.max_agents).toBe(100)
      expect(decoded.swarm?.max_active_agents).toBe(4)
      expect(decoded.swarm?.max_depth).toBe(3)
      expect(decoded.swarm?.max_children_per_agent).toBe(10)
      expect(decoded.swarm?.models?.allowed).toEqual(["anthropic/claude-sonnet-4", "openai/gpt-5"])
      expect(decoded.swarm?.approval?.merge).toBe("deny")
    }),
  )

  it.effect("accepts an empty allowed model list (fail-closed policy is semantic, not structural)", () =>
    Effect.sync(() => {
      const decoded = decode({ swarm: { enabled: true, models: { allowed: [] } } })
      expect(decoded.swarm?.models?.allowed).toEqual([])
    }),
  )

  it.effect("leaves swarm undefined when absent", () =>
    Effect.sync(() => {
      expect(decode({ model: "anthropic/claude-sonnet-4" }).swarm).toBeUndefined()
    }),
  )

  it.effect("rejects unknown approval actions", () =>
    Effect.sync(() => {
      expect(() => decode({ swarm: { approval: { spawn: "maybe" } } })).toThrow()
    }),
  )

  it.effect("rejects non-positive budgets", () =>
    Effect.sync(() => {
      expect(() => decode({ swarm: { max_agents: 0 } })).toThrow()
      expect(() => decode({ swarm: { max_active_agents: -1 } })).toThrow()
    }),
  )

  it.effect("treats swarm as a v1 key for v1/v2 detection", () =>
    Effect.sync(() => {
      expect(ConfigMigrateV1.isV1({ swarm: { enabled: true } })).toBe(true)
    }),
  )
})
