import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { join } from "node:path"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import net from "node:net"
import { randomBytes } from "node:crypto"

// ---------------------------------------------------------------------------
// `openswarm service` — the background daemon the desktop shell drives. A thin
// lifecycle layer over the existing `serve` command: start spawns a detached
// `serve` process (password-protected), status reports whether it is alive, and
// `get password` returns the credential. State is a single JSON file under the
// XDG state home (or Global.Path.state) so the desktop app can discover a
// daemon started by any channel.
// ---------------------------------------------------------------------------

interface ServiceState {
  url: string
  password: string
  pid: number
}

function stateFile(): string {
  const stateHome = process.env.XDG_STATE_HOME ?? Global.Path.state
  return join(stateHome, "service.json")
}

function readState(): ServiceState | undefined {
  const file = stateFile()
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ServiceState
  } catch {
    return undefined
  }
}

const findFreePort = () =>
  Effect.promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const server = net.createServer()
        server.unref()
        server.on("error", reject)
        server.listen(0, "127.0.0.1", () => {
          const address = server.address()
          const port = typeof address === "object" && address ? address.port : 0
          server.close(() => resolve(port))
        })
      }),
  )

const isAlive = (url: string) =>
  Effect.promise(async () => {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) })
      return true
    } catch {
      return false
    }
  })

const waitReady = (url: string) =>
  Effect.promise(async () => {
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
        if (res.status < 500) return
      } catch {
        // not ready yet
      }
      await Bun.sleep(100)
    }
    throw new Error(`service did not become ready at ${url}`)
  })

const spawnDetached = (port: number, password: string) =>
  Effect.sync(() => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "serve", "--port", String(port), "--hostname", "127.0.0.1"],
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    })
    proc.unref()
    return proc.pid
  })

const ServiceStart = effectCmd({
  command: "start",
  describe: "start the openSwarm background service",
  builder: (yargs) => yargs.option("port", { type: "number", describe: "port to listen on" }),
  instance: false,
  handler: Effect.fn("Cli.service.start")(function* (args: { port?: number }) {
    const existing = readState()
    if (existing && (yield* isAlive(existing.url))) {
      console.log(existing.url)
      return
    }
    const password = randomBytes(24).toString("hex")
    const port = args.port ?? (yield* findFreePort())
    const url = `http://127.0.0.1:${port}`
    const pid = yield* spawnDetached(port, password)
    yield* waitReady(url)
    writeFileSync(stateFile(), JSON.stringify({ url, password, pid } satisfies ServiceState))
    console.log(url)
  }),
})

const ServiceStatus = effectCmd({
  command: "status",
  describe: "check the openSwarm background service",
  instance: false,
  handler: Effect.fn("Cli.service.status")(function* () {
    const existing = readState()
    if (existing && (yield* isAlive(existing.url))) {
      console.log(`running ${existing.url}`)
    }
  }),
})

const ServiceGetPassword = effectCmd({
  command: "get password",
  describe: "get the openSwarm background service password",
  instance: false,
  handler: Effect.fn("Cli.service.getPassword")(function* () {
    const existing = readState()
    if (existing) console.log(existing.password)
  }),
})

export const ServiceCommand = cmd({
  command: "service",
  describe: "manage the openSwarm background service",
  builder: (yargs) =>
    yargs
      .command(ServiceStart)
      .command(ServiceStatus)
      .command(ServiceGetPassword)
      .demandCommand(),
  async handler() {},
})
