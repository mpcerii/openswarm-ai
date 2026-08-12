import { describe, expect } from "bun:test"
import { Config, Effect, Layer } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { SwarmPaths } from "../../src/server/routes/instance/httpapi/groups/swarm"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"

// ---------------------------------------------------------------------------
// Production-path contract test: mounts the EXACT route tree production uses
// (HttpApiApp.routes on a real Node HTTP server) and asserts the raw JSON body
// of /swarm/status — no {data:...} wrapper, zero counts valid.
// ---------------------------------------------------------------------------

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const original = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
    Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = original
        await resetDatabase()
      }),
    )
  }),
)

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const httpApiServerLayer = servedRoutes.pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

const it = testEffect(Layer.mergeAll(testStateLayer, httpApiServerLayer))

const directoryHeader = (dir: string) => HttpClientRequest.setHeader("x-opencode-directory", dir)

describe("swarm status production-path contract", () => {
  it.live(
    "returns a direct status object (no {data:...} wrapper) with zero agents",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: false })
        const status = yield* HttpClientRequest.get(SwarmPaths.status).pipe(
          directoryHeader(dir),
          HttpClient.execute,
        )
        expect(status.status).toBe(200)
        const json = (yield* status.json) as Record<string, unknown>
        // Print the exact shape so any future contract change is visible here.
        console.log("[swarm-status-raw]", JSON.stringify(json))
        // The TUI bridge reads top-level fields directly (no `data` wrapper).
        expect("enabled" in json).toBe(true)
        expect("population" in json).toBe(true)
        expect("active" in json).toBe(true)
        expect("models" in json).toBe(true)
        expect("data" in json).toBe(false)
        // Zero counts are valid and present.
        const population = json.population as { current: number; max: number }
        expect(population.current).toBe(0)
        expect(population.max).toBeGreaterThan(0)
        const active = json.active as { agents: number; max: number }
        expect(active.agents).toBe(0)
      }),
  )

  it.live(
    "pause/resume return valid status and agents list is a real array",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: false })
        const pause = yield* HttpClientRequest.post(SwarmPaths.pause).pipe(directoryHeader(dir), HttpClient.execute)
        expect(pause.status).toBe(200)
        const pauseJson = (yield* pause.json) as { enabled: boolean }
        expect("enabled" in pauseJson).toBe(true)

        const resume = yield* HttpClientRequest.post(SwarmPaths.resume).pipe(directoryHeader(dir), HttpClient.execute)
        expect(resume.status).toBe(200)
        const resumeJson = (yield* resume.json) as { enabled: boolean }
        expect("enabled" in resumeJson).toBe(true)

        const agents = yield* HttpClientRequest.get(SwarmPaths.agents).pipe(directoryHeader(dir), HttpClient.execute)
        expect(agents.status).toBe(200)
        const agentsJson = (yield* agents.json) as { agents: unknown[] }
        expect(Array.isArray(agentsJson.agents)).toBe(true)
      }),
  )
})
