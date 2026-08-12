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
import * as fs from "node:fs/promises"
import * as path from "node:path"

// ---------------------------------------------------------------------------
// Isolation tests. Prove the release-critical invariant:
//   user working tree before child execution == user working tree after
//   child execution, when integration has not been approved.
// Two isolated-write coding agents run in DISTINCT session directories; a
// marker file each writes lands only in its own workspace; the parent fixture
// tree never contains the markers.
// ---------------------------------------------------------------------------

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

// Real temp-dir backend: allocates a unique directory per agent under a root
// that lives inside the fixture's temp dir, so we can assert against it.
function tmpBackend(root: string) {
  return LayerNode.make({
    service: SwarmWorktreeBackend.Service,
    layer: SwarmWorktreeBackend.memoryLayer(root),
    deps: [],
  })
}

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

// Module-level test layer: real app services + the memory worktree backend.
// The backend root is the OS temp dir (always absolute), so workspace paths are
// real absolute dirs that are provably NOT the parent fixture tree.
const testLayer = AppNodeBuilder.build(root, [
  [SwarmWorktreeBackend.node, tmpBackend(require("node:os").tmpdir())],
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

describe("SwarmService worktree isolation (REQUIRED)", () => {
  test("two isolated-write agents write to distinct workspaces; parent tree unchanged", async () => {
    await provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const swarm = yield* SwarmService.Service
          const realOps = {
            cancel: (sessionID: SessionID) => prompt.cancel(sessionID),
            resolvePromptParts: (template: string) => prompt.resolvePromptParts(template),
            prompt: (input: Parameters<typeof prompt.prompt>[0]) => prompt.prompt(input).pipe(Effect.orDie),
          }

          // Agent A writes marker A via the `write` tool, then replies.
          yield* llm.tool("write", { filePath: "agent-marker.txt", content: "A" })
          yield* llm.text("done A")
          const a = yield* swarm.spawn(
            { objective: "create agent-marker.txt with content A", role: "implementer", workspaceMode: "isolated-write" },
            realOps,
          )
          expect(a.state).toBe("queued")
          expect(a.workspacePath).toBeDefined()

          // Wait for A to finish before B so the single shared TestLLMServer
          // reply queue is not consumed out of order by concurrent sessions.
          const waitFor = (id: string) =>
            pollWithTimeout(
              Effect.gen(function* () {
                const view = yield* swarm.get(id)
                return view?.agent.state === "completed" ? (view as never) : undefined
              }),
              `agent ${id} never completed`,
              "30 seconds",
            )
          yield* waitFor(a.agentID)

          // Agent B writes marker B.
          yield* llm.tool("write", { filePath: "agent-marker.txt", content: "B" })
          yield* llm.text("done B")
          const b = yield* swarm.spawn(
            { objective: "create agent-marker.txt with content B", role: "implementer", workspaceMode: "isolated-write" },
            realOps,
          )
          expect(b.state).toBe("queued")
          expect(b.workspacePath).toBeDefined()
          // Distinct workspaces.
          expect(a.workspacePath).not.toBe(b.workspacePath)
          yield* waitFor(b.agentID)

          // Both worktrees exist.
          const dirA = a.workspacePath!
          const dirB = b.workspacePath!
          const [ma, mb] = yield* Effect.all([
            Effect.promise(() => fs.readFile(path.join(dirA, "agent-marker.txt"), "utf8")),
            Effect.promise(() => fs.readFile(path.join(dirB, "agent-marker.txt"), "utf8")),
          ])
          expect(ma).toBe("A")
          expect(mb).toBe("B")

          // Parent fixture tree contains NEITHER marker.
          const parentHasMarker = yield* Effect.promise(() =>
            fs.stat(path.join(dir, "agent-marker.txt")).then(() => true).catch(() => false),
          )
          expect(parentHasMarker).toBe(false)
        }),
      { git: false, config: (url) => ({ model: "test/test-model", ...makeProviderConfig(url), swarm: { enabled: true, models: { allowed: ["test/test-model"] } } }) },
    )
      .pipe(Effect.scoped, Effect.provide(testLayer))
      .pipe(Effect.runPromise)
  }, 90000)
})

describe("shell cwd isolation (REQUIRED)", () => {
  test("child session working directory is the workspace, not the parent", async () => {
    await provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const swarm = yield* SwarmService.Service
          const session = yield* Session.Service
          const realOps = {
            cancel: (sessionID: SessionID) => prompt.cancel(sessionID),
            resolvePromptParts: (template: string) => prompt.resolvePromptParts(template),
            prompt: (input: Parameters<typeof prompt.prompt>[0]) => prompt.prompt(input).pipe(Effect.orDie),
          }

          yield* llm.tool("write", { filePath: "cwd-marker.txt", content: "cwd-ok" })
          yield* llm.text("done")
          const out = yield* swarm.spawn(
            { objective: "create cwd-marker.txt with content cwd-ok", role: "implementer", workspaceMode: "isolated-write" },
            realOps,
          )
          expect(out.state).toBe("queued")
          const childSessionID = out.sessionID as unknown as SessionID

          const done = yield* pollWithTimeout(
            Effect.gen(function* () {
              const view = yield* swarm.get(out.agentID)
              return view?.agent.state === "completed" ? (view as never) : undefined
            }),
            "agent never completed",
            "30 seconds",
          )
          void done

          // The child SESSION records its working directory as the worktree.
          const child = yield* session.get(childSessionID)
          expect(out.workspacePath).toBeDefined()
          expect(child.directory).toBe(out.workspacePath!)
          expect(child.directory).not.toBe(dir)

          // Parent tree still has no marker.
          const parentHasMarker = yield* Effect.promise(() =>
            fs.stat(path.join(dir, "cwd-marker.txt")).then(() => true).catch(() => false),
          )
          expect(parentHasMarker).toBe(false)
        }),
      { git: false, config: (url) => ({ model: "test/test-model", ...makeProviderConfig(url), swarm: { enabled: true, models: { allowed: ["test/test-model"] } } }) },
    )
      .pipe(Effect.scoped, Effect.provide(testLayer))
      .pipe(Effect.runPromise)
  }, 90000)
})

