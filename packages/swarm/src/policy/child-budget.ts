export * as SwarmChildBudget from "./child-budget"

// ---------------------------------------------------------------------------
// Child budget delegation. A parent may delegate part of its allocation to a
// child (e.g. root 1000 calls -> backend 300 / frontend 200 / reserve 500).
// Delegation is accounting-only and pure here; the runtime/store performs the
// atomic transfer so children can never mint or duplicate capacity.
// ---------------------------------------------------------------------------

export interface ChildAllocation {
  readonly modelCalls: number
  readonly tokens: number
  readonly cost: number
}

export interface Remaining {
  readonly modelCalls: number
  readonly tokens: number
  readonly cost: number
}

export function zero(): ChildAllocation {
  return { modelCalls: 0, tokens: 0, cost: 0 }
}

export type Delegation =
  | { ok: true; allocation: ChildAllocation; remaining: Remaining }
  | { ok: false; code: "insufficient_budget" }

// Attempt to move `amount` from the parent's remaining allocation to a child.
// Any dimension that does not fit fails the whole delegation (no partial
// transfers — partial state would let children duplicate capacity).
export function delegate(remaining: Remaining, amount: Partial<ChildAllocation>): Delegation {
  const calls = amount.modelCalls ?? 0
  const tokens = amount.tokens ?? 0
  const cost = amount.cost ?? 0
  if (calls < 0 || tokens < 0 || cost < 0) return { ok: false, code: "insufficient_budget" }
  if (remaining.modelCalls < calls || remaining.tokens < tokens || remaining.cost < cost) {
    return { ok: false, code: "insufficient_budget" }
  }
  return {
    ok: true,
    allocation: { modelCalls: calls, tokens, cost },
    remaining: { modelCalls: remaining.modelCalls - calls, tokens: remaining.tokens - tokens, cost: remaining.cost - cost },
  }
}

// Return a child's unused allocation to the parent.
export function reclaim(remaining: Remaining, allocation: ChildAllocation): Remaining {
  return {
    modelCalls: remaining.modelCalls + allocation.modelCalls,
    tokens: remaining.tokens + allocation.tokens,
    cost: remaining.cost + allocation.cost,
  }
}

// Consume from an allocation; false when the CALL allocation is exhausted so
// the runtime can queue the agent instead of exceeding a delegated budget.
// Model calls are the hard dimension (a delegated call count must not be
// exceeded). Token/cost consumption only draws against the child's balance
// when the parent explicitly delegated tokens/cost (a zero balance is
// "unbounded at the child level" — the mission budget still bounds it).
export function consume(allocation: ChildAllocation, calls = 1, tokens = 0, cost = 0): { ok: true; remaining: ChildAllocation } | { ok: false } {
  if (allocation.modelCalls < calls) return { ok: false }
  return {
    ok: true,
    remaining: {
      modelCalls: allocation.modelCalls - calls,
      tokens: allocation.tokens >= tokens ? allocation.tokens - tokens : 0,
      cost: allocation.cost >= cost ? allocation.cost - cost : 0,
    },
  }
}
