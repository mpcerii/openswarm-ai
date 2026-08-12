export * as SwarmProvider from "./provider"

import { SwarmAgent } from "../agent/agent"

// Swarm's own seam for LLM streaming. The real bridge later connects to the
// upstream `@opencode-ai/llm` package (or V1 `ai` SDK). Pure interface: the
// kernel depends on this shape and uses an injectable implementation, which
// is what makes the simulation + E2E tests run with NO paid LLM calls.

export interface ToolCall {
  readonly tool: string
  // Decoded by the kernel after policy validation. Never trusted as a free
  // "do anything" channel: high-risk tools route through SwarmApproval first.
  readonly args: Record<string, unknown>
}

export interface StreamChunk {
  // Assistant text emitted incrementally.
  readonly delta?: string
  // A requested tool call mid-stream. Empty when idle.
  readonly toolCalls?: ToolCall[]
  // Soft token accounting incremented as the provider produces tokens. Used
  // by the mission token budget.
  readonly tokens?: number
  // "stop" indicates the model finished a turn. "paused" means the model
  // requested a clarification (kernel reprompts). "error" aborts the step.
  readonly finish?: "stop" | "paused" | "error"
  readonly error?: string
}

export interface StreamRequest {
  readonly agentID: SwarmAgent.ID
  readonly model: string
  // Role the agent is currently playing (e.g. "investigator", "implementer",
  // "reviewer", "primary"). Routing metadata only; the runtime keeps the
  // authoritative record on SwarmAgent.RuntimeRecord.
  readonly role?: string
  readonly systemPrompt: string
  readonly userText: string
  // File paths the agent has read access to; the kernel enumerates these
  // from the project census rather than dumping the entire repo into context.
  readonly permittedFiles?: readonly string[]
  readonly missionID: string
  readonly parentAgentID?: SwarmAgent.ID
}

export interface Provider {
  stream(req: StreamRequest): AsyncIterable<StreamChunk>
}

// Scripted fake provider for tests & simulation. Routes by agent role so a
// 10k-agent simulation can describe each role's behaviour in a few lines
// instead of producing actual LLM token traffic. Deterministic: same input
// produces the same output every run.
export type FakeBehavior = (req: StreamRequest, step: number) => StreamChunk[]

export interface FakeProviderOptions {
  readonly behaviorsByRole?: ReadonlyMap<string, FakeBehavior>
  readonly behaviorsByID?: ReadonlyMap<string, FakeBehavior>
  readonly fallback?: FakeBehavior
}

export interface FakeProvider extends Provider {
  readonly historicCalls: StreamRequest[]
}

export function makeFakeProvider(opts: FakeProviderOptions = {}): FakeProvider {
  const historicCalls: StreamRequest[] = []
  const noop: FakeBehavior = () => [{ finish: "stop" }]
  return {
    historicCalls,
    async *stream(req) {
      historicCalls.push(req)
      let step = 0
      for (;;) {
        const behavior = opts.behaviorsByID?.get(req.agentID)
          ?? opts.behaviorsByRole?.get(req.role ?? "unknown")
          ?? opts.fallback
          ?? noop
        const chunks = behavior(req, step)
        for (const c of chunks) yield c
        const last = chunks[chunks.length - 1]
        if (last === undefined || last.finish === "stop" || last.finish === "error" || step >= 16) break
        step++
      }
    },
  }
}

// Convenience provider used by the 10k-agent simulation: single-tick echo
// stop. This keeps provider call traffic cheap and deterministic regardless
// of population size; per-role simulation behaviour is layered on top by the
// runtime instead of by the provider.
export function echoProvider(): Provider {
  return {
    async *stream(req) {
      yield { delta: `ok(${req.agentID})`, finish: "stop", tokens: 8 }
    },
  }
}