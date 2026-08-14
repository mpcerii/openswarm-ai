import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Project-local team memory. A single append-only JSONL file under the
// project's `.openswarm` directory. Records are deliberately compact — one
// short fact per line, keyed by a kind tag — so reading memory back is token
// cheap and agents never have to re-discover the same project facts. The file
// is human-auditable but optimized for machine consumption, not prose.
//
//   {"ts":1786550000000,"k":"fact","c":"auth lives in packages/core/src/auth"}
// ---------------------------------------------------------------------------

export type MemoryKind = "fact" | "decision" | "todo" | "gotcha" | "result"

export function memoryFile(cwd = process.cwd()): string {
  return join(cwd, ".openswarm", "memory.jsonl")
}

export function memoryAdd(record: { kind: MemoryKind; content: string }, cwd = process.cwd()): void {
  const file = memoryFile(cwd)
  if (!existsSync(join(cwd, ".openswarm"))) mkdirSync(join(cwd, ".openswarm"), { recursive: true })
  const line = JSON.stringify({ ts: Date.now(), k: record.kind, c: record.content }) + "\n"
  appendFileSync(file, line, "utf8")
}

export function memoryRead(limit = 50, cwd = process.cwd()): string[] {
  const file = memoryFile(cwd)
  if (!existsSync(file)) return []
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0)
  return lines.slice(-limit)
}

export function memorySearch(query: string, limit = 20, cwd = process.cwd()): string[] {
  const file = memoryFile(cwd)
  if (!existsSync(file)) return []
  const q = query.toLowerCase()
  return readFileSync(file, "utf8").split("\n").filter((l) => l.toLowerCase().includes(q)).slice(-limit)
}

export function memoryCompact(line: string): string {
  try {
    const r = JSON.parse(line) as { ts?: number; k?: string; c?: string }
    return `${r.k ?? "?"}: ${r.c ?? line}`
  } catch {
    return line
  }
}
