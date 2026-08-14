import { $ } from "bun"
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// openSwarm CLI release used by the desktop shell. Override with
// OPENCODE_VERSION to pin a specific release (e.g. 1.0.1).
const CLI_VERSION = Bun.env.OPENCODE_VERSION ?? "1.0.0"
const CLI_RELEASE_BASE = `https://github.com/mpcerii/openswarm-ai/releases/download/v${CLI_VERSION}`

export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(): Channel {
  const raw = Bun.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
}

export const CLI_BINARIES: Array<{ rustTarget: string; asset: string; os: string; cpu: string; archive: "zip" | "tar.gz" }> = [
  { rustTarget: "aarch64-apple-darwin", asset: "opencode-darwin-arm64", os: "darwin", cpu: "arm64", archive: "zip" },
  { rustTarget: "x86_64-apple-darwin", asset: "opencode-darwin-x64-baseline", os: "darwin", cpu: "x64", archive: "zip" },
  { rustTarget: "aarch64-pc-windows-msvc", asset: "opencode-windows-arm64", os: "win32", cpu: "arm64", archive: "zip" },
  { rustTarget: "x86_64-pc-windows-msvc", asset: "opencode-windows-x64-baseline", os: "win32", cpu: "x64", archive: "zip" },
  { rustTarget: "x86_64-unknown-linux-gnu", asset: "opencode-linux-x64-baseline", os: "linux", cpu: "x64", archive: "tar.gz" },
  { rustTarget: "aarch64-unknown-linux-gnu", asset: "opencode-linux-arm64", os: "linux", cpu: "arm64", archive: "tar.gz" },
]

export const RUST_TARGET = Bun.env.RUST_TARGET

function nativeTarget() {
  const { platform, arch } = process
  if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  if (platform === "win32") return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
  if (platform === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  throw new Error(`Unsupported platform: ${platform}/${arch}`)
}

export function getCurrentCli(target = RUST_TARGET ?? nativeTarget()) {
  const binaryConfig = CLI_BINARIES.find((item) => item.rustTarget === target)
  if (!binaryConfig) throw new Error(`CLI configuration not available for target '${target}'`)

  return binaryConfig
}

export async function downloadCliToResources() {
  const cli = getCurrentCli()
  const directory = await mkdtemp(join(tmpdir(), "openswarm-cli-"))
  const dest = windowsify("resources/openswarm-cli")
  const archive = join(directory, `${cli.asset}.${cli.archive}`)
  try {
    const url = `${CLI_RELEASE_BASE}/${cli.asset}.${cli.archive}`
    await $`curl -fsSL -o ${archive} ${url}`
    if (cli.archive === "zip") {
      await $`unzip -q -o ${archive} -d ${directory}`
    } else {
      await $`tar -xzf ${archive} -C ${directory}`
    }
    await copyFile(join(directory, cli.os === "win32" ? "opencode.exe" : "opencode"), dest)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  if (process.platform !== "win32") await chmod(dest, 0o755)
  if (process.platform === "darwin") await $`codesign --force --sign - ${dest}`

  console.log(`Copied ${cli.asset}.${cli.archive} to ${dest}`)
}

export function windowsify(path: string) {
  if (path.endsWith(".exe")) return path
  return `${path}${process.platform === "win32" ? ".exe" : ""}`
}
