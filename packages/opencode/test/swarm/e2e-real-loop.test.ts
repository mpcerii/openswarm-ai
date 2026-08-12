import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { pollWithTimeout } from "../lib/effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { TestLLMServer } from "../lib/llm-server"
import { provideTmpdirServer } from "../fixture/fixture"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "../../src/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { MessageV2 } from "../../src/session/message-v2"
import { Snapshot } from "../../src/snapshot"
import { LLM } from "../../src/session/llm"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Command } from "../../src/command"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Config } from "../../src/config/config"
import { Provider as ProviderSvc } from "../../src/provider/provider"
import { LSP } from "../../src/lsp/lsp"
import { MCP } from "../../src/mcp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { BackgroundJob } from "../../src/background/job"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { ToolRegistry } from "../../src/tool/registry"
import { Skill } from "../../src/skill"
import { Git } from "../../src/git"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { Truncate } from "../../src/tool/truncate"
import { SessionProcessor } from "../../src/session/processor"
import { Image } from "../../src/image/image"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionRevert } from "../../src/session/revert"
import { Instruction } from "../../src/session/instruction"
import { SystemPrompt } from "../../src/session/system"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { SwarmService } from "../../src/swarm/service"
import { SwarmWorktreeBackend } from "../../src/swarm/worktree-backend"
import { SessionID } from "../../src/session/schema"

// Full-loop E2E: spawn a swarm agent with the REAL promptOps seam and assert
// the child session performs an actual model call against the TestLLMServer.
// This proves the acceptance path: primary -> spawn_agent -> scheduler ->
// logical child -> REAL OpenCode session -> real allowed model.

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })
const memoryWorktreeNode = LayerNode.make({
  service: SwarmWorktreeBackend.Service,
  layer: SwarmWorktreeBackend.memoryLayer("<mem>"),
  deps: [],
})

const root = LayerNode.group([
  SwarmService.node,
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  testLLMServerNode,
])
const testLayer = AppNodeBuilder.build(root, [
  [SwarmWorktreeBackend.node, memoryWorktreeNode],
] as const)

function makeProviderConfig(url: string) {
  return {
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
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
}

describe("SwarmService real-loop E2E (child agent runs a real model turn)", () => {
  test("spawned agent executes a REAL model session through the TestLLMServer", async () => {
    await provideTmpdirServer(
      () =>
        Effect.gen(function* () {
          const llm = yield* TestLLMServer
          const prompt = yield* SessionPrompt.Service
          const swarm = yield* SwarmService.Service

          const realOps = {
            cancel: (sessionID: SessionID) => prompt.cancel(sessionID),
            resolvePromptParts: (template: string) => prompt.resolvePromptParts(template),
            prompt: (input: Parameters<typeof prompt.prompt>[0]) => prompt.prompt(input).pipe(Effect.orDie),
          }

          yield* llm.text("Investigation complete: the auth failure is a token-format bug.")

          const out = yield* swarm.spawn(
            { objective: "Inspect the failing auth test and report the root cause.", role: "investigator" },
            realOps,
          )
          expect(out.state).toBe("queued")
          expect(out.sessionID).toBeDefined()
          const childSession = out.sessionID as unknown as SessionID

          yield* llm.wait(1)
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const status = yield* SessionStatus.Service
              const s = yield* status.get(childSession)
              return s.type === "idle" ? (true as const) : undefined
            }),
            `child session ${childSession} never became idle`,
            "30 seconds",
          )

          const done = yield* pollWithTimeout(
            Effect.gen(function* () {
              const view = yield* swarm.get(out.agentID)
              return view?.agent.state === "completed" ? (view as never) : undefined
            }),
            "agent never completed",
            "30 seconds",
          )
          void done

          const session = yield* Session.Service
          const msgs = yield* session.messages({ sessionID: childSession })
          const texts = msgs.flatMap((m) => m.parts).filter((p) => p.type === "text").map((p) => p.text)
          expect(texts.some((t) => t.includes("auth failure"))).toBe(true)
        }),
      { git: false, config: (url) => ({ model: "test/test-model", ...makeProviderConfig(url), swarm: { enabled: true, models: { allowed: ["test/test-model"] } } }) },
    )
      .pipe(Effect.scoped, Effect.provide(testLayer))
      .pipe(Effect.runPromise)
  }, 60000)
})