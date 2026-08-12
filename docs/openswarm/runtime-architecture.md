# openSwarm Runtime Architecture (Phase 5)

Extends `docs/openswarm/architecture-baseline.md` with the swarm runtime
kernel built in this phase. All code lives in `packages/swarm` and depends
only on `@opencode-ai/schema` + `effect`; nothing upstream is modified.

## Layered design

```text
┌────────────────────────────────────────────────────────────────┐
│  TUI / CLI (future)   /swarm, /agents, /why, model governance   │
└──────────────────────────────────────────────┬─────────────────┘
                                               │
┌──────────────────────────────────────────────▼─────────────────┐
│  SwarmRuntime  (src/runtime/runtime.ts)                        │
│  · mission + census lifecycle                                  │
│  · recursive spawn (budget → model policy → approval)          │
│  · scheduler tick (bounded active + workspace concurrency)     │
│  · tool dispatch (finding / patch / review / integration)      │
│  · approval engine + scoped grants                             │
│  · review swarms (read-only reviewers)                         │
│  · integration ledger (approval-gated)                         │
│  · /why provenance viewer                                      │
└───────┬──────────────────┬─────────────────┬──────────────────┘
        │                  │                 │
        ▼                  ▼                 ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│ Pure policy   │  │  Seams        │  │  State        │
│ SwarmBudget   │  │ SwarmProvider │  │ agents/tasks/ │
│ SwarmModels   │  │ SwarmWorkspace│  │ artifacts/    │
│ SwarmApproval │  │ (real bridge  │  │ approvals/    │
│ SwarmReview   │  │  later)       │  │ audit/        │
│ SwarmDedup    │  │               │  │ clustering/   │
│ SwarmConflict │  │               │  │ leases/queue  │
└───────────────┘  └───────────────┘  └───────────────┘
```

## Key invariants enforced by the kernel

1. **Fail-closed models.** `SwarmModels.resolve` grants a model only when the
   exact `"provider/model"` id is in `swarm.models.allowed`. Empty list = no
   models. LLM-supplied tool arguments never choose the model — the kernel
   resolves it from policy before any provider call.
2. **Bounded population & concurrency.** `SwarmBudget` accounts population,
   active slots and children-per-parent atomically; the scheduler admits only
   up to `max_active_agents` (64 in the sim), and coding workspaces only up
   to `max_active_coding_workspaces` (16). A 10k-agent run therefore executes
   ≤64 at once and allocates ≤16 worktrees.
3. **Patches, not merges.** Implementers write to an allocated workspace and
   emit a `PatchBody` artifact (base commit, files, diff, tests, results,
   reason). They never write to the primary working tree. Integration is a
   separate, approval-gated step (`integration` action).
4. **Conflict control.** `SwarmConflict` leases are exclusive by area;
   overlapping writers are parked (`waiting`) until the lease frees. Merge
   prediction flags patch pairs that touch the same files.
5. **Reviews gate integration.** `SwarmReview.isAcceptable` requires a
   majority of `accept` AND no blocker/high findings. Confidence is never
   sufficient. Adversarial objectives (`assume the patch is wrong`) are
   supported.
6. **Dedup with provenance.** Findings fingerprint on normalized
   title+area+location; identical concepts cluster into a canonical `OSW-*`
   finding while preserving every reporter id.
7. **Approval cannot be broadened.** `SwarmApproval.evaluate` treats an
   explicit configured `deny` as authoritative over grants; a grant only
   allows actions at or below its own risk rank (R0..R4). Expiry and
   max-uses are honoured.
8. **Bounded recovery.** `SwarmRecovery.nextStep` never retries past
   `maxAttempts`, and terminal failure classes (e.g. cancellation) are never
   retried. Failed agents can be re-queued without losing the mission.
9. **Attribution.** Every important transition emits a redacted audit event
   (`mission.created`, `swarm.agent.*`, `swarm.task.*`, `swarm.tool.*`,
   `swarm.artifact.created`, `swarm.review.created`, `swarm.approval.*`,
   `swarm.workspace.*`, `swarm.integration.*`, `swarm.finding.clustered`).
   `/why <file>` reconstructs the mission → task → implementer → patch →
   review → approval → integration chain.

## Determinism & testing without paid LLM traffic

`SwarmProvider` is an injectable seam. Tests use `makeFakeProvider` with
scripted per-role behaviors, so the simulation and E2E tests make **zero**
model calls. The 10k-agent test (`test/swarm.test.ts`) records:
population 10000, admitted 9999, activePeak 64 (bound), workspacePeak 16
(bound), ~1.1s wall, ~75k audit events, heap ~200 MB.

## Not implemented yet (debt)

- durable SQLite persistence (row shapes/DDL in `src/schema.ts`)
- real provider bridge to `@opencode-ai/llm` / V1 `ai` SDK
- real worktree backend via OpenCode `Worktree` service
- TUI: `/swarm`, `/agents`, `/why`, model-governance checkboxes
- real-repository census scanner (auto-build `SwarmCensus.Info`)
