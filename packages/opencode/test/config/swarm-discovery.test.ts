import { describe, expect } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { ConfigPaths } from "@/config/paths"
import { testEffect } from "../lib/effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"

// ---------------------------------------------------------------------------
// Config discovery: when the CLI runs from packages/opencode, the project
// opencode.json at the repo root must still be found (findUp walks up). This
// pins the real behavior for the documented launch command.
// ---------------------------------------------------------------------------

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node, Global.node]) as never))

describe("swarm config discovery from a subdirectory launch", () => {
  it.live(
    "findUp discovers the repo-root opencode.json from a nested launch dir",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.promise(() => tmpdir())
        const rootDir = tmp.path
        // Simulate the repo layout: root opencode.json + nested launch subdir.
        const nestedDir = path.join(rootDir, "packages", "opencode")
        fs.mkdirSync(nestedDir, { recursive: true })
        fs.writeFileSync(
          path.join(rootDir, "opencode.json"),
          JSON.stringify({
            model: "test/test-model",
            swarm: { enabled: true, models: { allowed: ["test/test-model"] } },
          }),
        )

        // ConfigPaths.files walks UP from the launch directory and must find
        // the repo-root opencode.json.
        const files = yield* ConfigPaths.files("opencode", nestedDir, undefined).pipe(Effect.orDie)
        const found = files.find((f) => path.basename(f) === "opencode.json")
        expect(found).toBeDefined()
        const content = JSON.parse(fs.readFileSync(found!, "utf8")) as { swarm?: { enabled?: boolean; models?: { allowed?: string[] } } }
        expect(content.swarm?.enabled).toBe(true)
        expect(content.swarm?.models?.allowed).toEqual(["test/test-model"])
      }),
  )
})


