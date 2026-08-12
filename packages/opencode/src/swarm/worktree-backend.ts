export * as SwarmWorktreeBackend from "./worktree-backend"

import { Effect, Layer, Context } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Worktree } from "@/worktree"

// ---------------------------------------------------------------------------
// Real worktree backend for the swarm workspace abstraction. Coding agents get
// an isolated working directory instead of mutating the user's primary tree.
//
// The `Worktree` service (real git worktrees under Global.Path.data/worktree)
// is resolved OPTIONALLY: when the app wires it (server/TUI), isolated-write
// agents get real git worktrees. When it is absent (unit tests without git),
// a temp-dir backend provides the same isolation semantics with zero git
// dependency — so compiling this node never drags git into test layers.
// Read-only agents never allocate a workspace.
// ---------------------------------------------------------------------------

export interface WorkspaceAllocation {
  readonly directory: string
  readonly branch?: string
}

export interface Backend {
  allocate(agentID: string, branch: string): Effect.Effect<WorkspaceAllocation>
  release(agentID: string): Effect.Effect<void>
}

export class Service extends Context.Service<Service, Backend>()("@opencode/SwarmWorktreeBackend") {}

// Real git-worktree backend backed by the Worktree service.
function realBackend(worktrees: Worktree.Interface): Backend {
  const active = new Map<string, WorkspaceAllocation>()
  return {
    allocate: (agentID, branch) =>
      Effect.gen(function* () {
        const existing = active.get(agentID)
        if (existing !== undefined) return existing
        const info = yield* worktrees.create({ name: branch }).pipe(Effect.orDie)
        const allocation: WorkspaceAllocation = { directory: info.directory, branch: info.branch }
        active.set(agentID, allocation)
        return allocation
      }),
    release: (agentID) =>
      Effect.gen(function* () {
        const allocation = active.get(agentID)
        if (allocation === undefined) return
        yield* worktrees.remove({ directory: allocation.directory }).pipe(Effect.catch(() => Effect.succeed(false)))
        active.delete(agentID)
      }),
  }
}

// Temp-dir backend (no git): allocates a real absolute temp directory per
// agent so isolation semantics are fully testable anywhere.
function tempBackend(root: string): Backend {
  const active = new Map<string, WorkspaceAllocation>()
  const fs = require("node:fs") as typeof import("node:fs")
  return {
    allocate: (agentID, branch) =>
      Effect.sync(() => {
        const existing = active.get(agentID)
        if (existing !== undefined) return existing
        const directory = require("node:path").join(root, `ws-${agentID.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`)
        fs.mkdirSync(directory, { recursive: true })
        const allocation: WorkspaceAllocation = { directory, branch }
        active.set(agentID, allocation)
        return allocation
      }),
    release: (agentID) =>
      Effect.sync(() => {
        const allocation = active.get(agentID)
        if (allocation !== undefined) {
          fs.rmSync(allocation.directory, { recursive: true, force: true })
          active.delete(agentID)
        }
      }),
  }
}

// In-memory backend for explicit test injection (fixed root label).
export function memoryBackend(root: string): Backend {
  return tempBackend(root)
}

export const memoryLayer = (root: string): Layer.Layer<Service> =>
  Layer.succeed(Service, Service.of(memoryBackend(root)))

// The node depends on nothing statically: git is optional. Production wires
// Worktree.node through the app; tests without it get the temp-dir backend.
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const worktreeOption = yield* Effect.serviceOption(Worktree.Service)
    if (worktreeOption._tag === "Some") return realBackend(worktreeOption.value)
    return tempBackend(require("node:os").tmpdir())
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export const Default = layer