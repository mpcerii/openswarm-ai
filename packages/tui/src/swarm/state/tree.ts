import type { SwarmAgent } from "@opencode-ai/swarm/agent/agent"
import type { SwarmUiAgent, SwarmUiSnapshot, SwarmUiWorker } from "./types"

// ---------------------------------------------------------------------------
// Hierarchy tree + execution-lane worker projection.
//
// The tree must stay responsive at 10,000 agents: it is built once per
// snapshot with O(n) indexing, and rendering walks only the *expanded* nodes
// (collapsed subtrees contribute a bracketed descendant count). Filtering uses
// the per-state / per-model indexes from the snapshot rather than re-scanning
// every agent on every keystroke.
// ---------------------------------------------------------------------------

export interface TreeIndexes {
  childrenByParent: Map<string, number[]>
  roots: number[]
  descendantCounts: Map<number, number>
  childCounts: Map<number, number>
}

// One O(n) pass: childrenByParent, roots, and descendant counts (post-order).
export function buildTreeIndexes(agents: ReadonlyArray<SwarmUiAgent>): TreeIndexes {
  const idToIndex = new Map<string, number>()
  for (let index = 0; index < agents.length; index++) idToIndex.set(agents[index].id, index)
  const childrenByParent = new Map<string, number[]>()
  const roots: number[] = []
  for (let index = 0; index < agents.length; index++) {
    const parent = agents[index].parent
    if (parent === undefined) {
      roots.push(index)
      continue
    }
    const list = childrenByParent.get(parent)
    if (list === undefined) childrenByParent.set(parent, [index])
    else list.push(index)
  }
  const childCounts = new Map<number, number>()
  for (const [parent, children] of childrenByParent) {
    const parentIndex = idToIndex.get(parent)
    if (parentIndex !== undefined) childCounts.set(parentIndex, children.length)
  }
  return { childrenByParent, roots, descendantCounts: computeDescendantCounts(agents, childrenByParent), childCounts }
}

function computeDescendantCounts(agents: ReadonlyArray<SwarmUiAgent>, childrenByParent: Map<string, number[]>): Map<number, number> {
  const counts = new Map<number, number>()
  // Post-order via explicit stack to avoid recursion depth issues at 10k.
  const stack: number[] = []
  const visited = new Set<number>()
  for (const index of agents.keys()) stack.push(index)
  while (stack.length > 0) {
    const index = stack.pop()!
    if (visited.has(index)) {
      let total = 0
      const children = childrenByParent.get(agents[index].id)
      if (children !== undefined) for (const child of children) total += 1 + (counts.get(child) ?? 0)
      counts.set(index, total)
      continue
    }
    visited.add(index)
    stack.push(index)
    const children = childrenByParent.get(agents[index].id)
    if (children !== undefined) for (const child of children) stack.push(child)
  }
  return counts
}

export interface TreeQuery {
  expanded: ReadonlySet<string>
  filter: string
  stateFilter: "all" | SwarmAgent.State
  modelFilter: string
  page: number
  pageSize: number
}

export interface TreeNodeView {
  index: number
  id: string
  depth: number
  parent?: string
  expanded: boolean
  hasChildren: boolean
  descendantCount: number
  childCount: number
  role?: string
  state: SwarmAgent.State
  resolvedModel?: string
}

export interface TreeResult {
  nodes: TreeNodeView[]
  total: number
  pages: number
  // True when the query is narrowing (search / state / model filter).
  filtered: boolean
}

// Number of "execution lanes" the worker view presents, derived from the
// active-agent bound. Matches the shape ControlPlane.metrics() exposes.
export function workerCount(maxActiveAgents: number): number {
  return Math.max(1, Math.min(8, Math.ceil(maxActiveAgents / 8)))
}

// Project running agents onto worker lanes round-robin so the operator sees
// where execution is happening. Real cluster mode swaps this projection for
// ControlPlane cluster metrics; the shape is identical.
export function workersFromAgents(agents: ReadonlyArray<SwarmUiAgent>, count: number): SwarmUiWorker[] {
  const names = ["web-1", "web-2", "web-3", "web-4", "web-5", "web-6", "web-7", "web-8"]
  const workers: SwarmUiWorker[] = Array.from({ length: count }, (_, i) => ({
    id: `sww_lane_${i + 1}`,
    name: names[i] ?? `lane-${i + 1}`,
    health: "healthy",
    active: 0,
    max: 0,
    ratio: 0,
    llmActive: 0,
  }))
  const running: SwarmUiAgent[] = []
  for (const agent of agents) {
    if (agent.state === "running") running.push(agent)
  }
  const max = Math.max(1, Math.ceil(Math.max(running.length, 1) / count))
  for (const w of workers) w.max = max
  running.forEach((agent, i) => {
    const worker = workers[i % count]!
    worker.active += 1
    if (agent.resolvedModel !== undefined) worker.llmActive += 1
  })
  for (const w of workers) w.ratio = w.max === 0 ? 0 : w.active / w.max
  return workers
}

const matchCache = new WeakMap<SwarmUiAgent, string>()

function searchable(agent: SwarmUiAgent): string {
  let value = matchCache.get(agent)
  if (value === undefined) {
    value = [agent.id, agent.role, agent.mission, agent.resolvedModel, agent.model, agent.state, agent.lastError]
      .filter((x) => x !== undefined && x !== null)
      .join(" ")
      .toLowerCase()
    matchCache.set(agent, value)
  }
  return value
}

// Walk only the expanded tree, returning a paginated window. Collapsed nodes
// never have their children enumerated, so opening the overlay over a 10k
// agent swarm renders just the first page of roots + their bracketed counts.
export function visibleTree(snapshot: SwarmUiSnapshot, query: TreeQuery): TreeResult {
  const { filter, stateFilter, modelFilter, page, pageSize } = query
  const needle = filter.trim().toLowerCase()
  const filtering = needle.length > 0 || stateFilter !== "all" || modelFilter.length > 0

  const matches = (index: number): boolean => {
    const agent = snapshot.agents[index]!
    if (stateFilter !== "all" && agent.state !== stateFilter) return false
    if (modelFilter.length > 0 && agent.resolvedModel !== modelFilter) return false
    if (needle.length === 0) return true
    return searchable(agent).includes(needle)
  }

  // Flat filtered projection: use the state/model indexes to avoid a full scan.
  let candidates: number[]
  if (filtering) {
    const pools = new Set<number>()
    if (stateFilter !== "all") {
      for (const index of snapshot.agentsByState.get(stateFilter) ?? []) pools.add(index)
    } else {
      for (const index of snapshot.agents.keys()) pools.add(index)
    }
    if (modelFilter.length > 0) {
      const modelSet = new Set(snapshot.agentsByModel.get(modelFilter) ?? [])
      for (const index of pools) {
        if (!modelSet.has(index)) pools.delete(index)
      }
    }
    candidates = [...pools].filter(matches)
  } else {
    candidates = [...snapshot.agents.keys()]
  }

  if (filtering) {
    const total = candidates.length
    const pages = Math.max(1, Math.ceil(total / pageSize))
    const start = Math.min(page, pages - 1) * pageSize
    const slice = candidates.slice(start, start + pageSize)
    return { nodes: slice.map((index) => toNode(snapshot, index, query)), total, pages, filtered: true }
  }

  // Tree walk: skip collapsed subtrees, paginate the visible row stream.
  const nodes: TreeNodeView[] = []
  let total = 0
  const start = page * pageSize
  const end = start + pageSize
  const stack: { index: number; depth: number }[] = snapshot.roots.map((index) => ({ index, depth: 0 }))
  while (stack.length > 0) {
    const current = stack.pop()!
    total++
    const agent = snapshot.agents[current.index]!
    const expanded = query.expanded.has(agent.id)
    const hasChildren = (snapshot.childrenByParent.get(agent.id)?.length ?? 0) > 0
    if (total > start && total <= end) {
      nodes.push({
        index: current.index,
        id: agent.id,
        depth: current.depth,
        parent: agent.parent,
        expanded: hasChildren && expanded,
        hasChildren,
        descendantCount: snapshot.descendantCounts.get(current.index) ?? 0,
        childCount: snapshot.childCounts.get(current.index) ?? 0,
        role: agent.role,
        state: agent.state,
        resolvedModel: agent.resolvedModel,
      })
    }
    if (total > end) break
    if (hasChildren && expanded) {
      const children = snapshot.childrenByParent.get(agent.id)!
      for (let i = children.length - 1; i >= 0; i--) stack.push({ index: children[i]!, depth: current.depth + 1 })
    }
  }
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return { nodes, total, pages, filtered: false }
}

function toNode(snapshot: SwarmUiSnapshot, index: number, query: TreeQuery): TreeNodeView {
  const agent = snapshot.agents[index]!
  const hasChildren = (snapshot.childrenByParent.get(agent.id)?.length ?? 0) > 0
  return {
    index,
    id: agent.id,
    depth: agent.depth,
    parent: agent.parent,
    expanded: query.expanded.has(agent.id),
    hasChildren,
    descendantCount: snapshot.descendantCounts.get(index) ?? 0,
    childCount: snapshot.childCounts.get(index) ?? 0,
    role: agent.role,
    state: agent.state,
    resolvedModel: agent.resolvedModel,
  }
}

// Path from the primary root to the requested agent; the caller expands all
// ancestors so the target becomes visible after one jump.
export function expansionPath(snapshot: SwarmUiSnapshot, agentID: string): string[] {
  const path: string[] = []
  let current = agentID
  for (let guard = 0; guard < 128; guard++) {
    const index = snapshot.agentsByID.get(current)
    if (index === undefined) return path
    const parent = snapshot.agents[index]!.parent
    if (parent === undefined) break
    path.unshift(parent)
    current = parent
  }
  return path
}

// The zero-based page on which the given agent row appears given the current
// expanded set. Used by jump-to-agent so the tree paginates to the target.
export function pageForNode(snapshot: SwarmUiSnapshot, query: TreeQuery, agentID: string): number {
  const { filter, stateFilter, modelFilter, pageSize } = query
  if (filter.trim().length > 0 || stateFilter !== "all" || modelFilter.length > 0) {
    const index = snapshot.agentsByID.get(agentID)
    if (index === undefined) return 0
    let rank = 0
    for (const candidate of candidatesFor(snapshot, query)) {
      if (candidate === index) return Math.floor(rank / pageSize)
      rank++
    }
    return 0
  }
  let total = 0
  const stack: { index: number }[] = snapshot.roots.map((index) => ({ index }))
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.index === snapshot.agentsByID.get(agentID)) return Math.floor(total / pageSize)
    total++
    const agent = snapshot.agents[current.index]!
    const hasChildren = (snapshot.childrenByParent.get(agent.id)?.length ?? 0) > 0
    if (hasChildren && query.expanded.has(agent.id)) {
      const children = snapshot.childrenByParent.get(agent.id)!
      for (let i = children.length - 1; i >= 0; i--) stack.push({ index: children[i]! })
    }
  }
  return 0
}

function candidatesFor(snapshot: SwarmUiSnapshot, query: TreeQuery): number[] {
  const { filter, stateFilter, modelFilter } = query
  const needle = filter.trim().toLowerCase()
  const pools = new Set<number>()
  if (stateFilter !== "all") {
    for (const index of snapshot.agentsByState.get(stateFilter) ?? []) pools.add(index)
  } else {
    for (const index of snapshot.agents.keys()) pools.add(index)
  }
  if (modelFilter.length > 0) {
    const modelSet = new Set(snapshot.agentsByModel.get(modelFilter) ?? [])
    for (const index of pools) {
      if (!modelSet.has(index)) pools.delete(index)
    }
  }
  const out: number[] = []
  for (const index of pools) {
    const agent = snapshot.agents[index]!
    if (needle.length === 0 || searchable(agent).includes(needle)) out.push(index)
  }
  return out
}

// Filter options offered in the agents view, sourced from the snapshot index.
export function distinctModels(snapshot: SwarmUiSnapshot): string[] {
  return [...snapshot.agentsByModel.keys()].toSorted()
}
