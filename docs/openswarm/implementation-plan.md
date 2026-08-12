# openSwarm Implementation Plan

Maps existing OpenCode components to the openSwarm architecture and sequences
the work. Guiding rule: **extend, don't duplicate** — OpenCode's session,
permission, provider, event, and snapshot machinery are reused; the swarm
layer adds accounting, scheduling, and governance on top.

## Component mapping

| openSwarm concept | Existing OpenCode asset | Plan |
| --- | --- | --- |
| Logical agent | `Session` with `parentID` + `Agent.Info` (task tool already creates child sessions) | A swarm agent *owns* an OpenCode session when running, but the agent record outlives any single session: new durable `swarm_agent` records (state machine, parent chain, mission, budget receipts). Sessions remain the unit of model execution. |
| Primary agent | `build` agent, default session | Unchanged. Swarm tools are added to the primary agent's toolset; UI stays the normal coding experience. |
| Recursive spawn | `task` tool + `subagent_depth` | Keep `task` as-is for compatibility. New `spawn_agent`/`spawn_agents` tools go through the swarm runtime, which enforces `maxDepth`, `maxChildrenPerAgent`, and global population budget (replacing the per-call depth walk with accounted budgets). |
| Scheduler / active bound | None today (no concurrency cap) | New swarm scheduler: admits `queued` agents up to `maxActiveAgents`, one OpenCode session drain per running agent. Reuses `SessionRunCoordinator` semantics (per-session serialization, cross-session concurrency). |
| Messaging | `session_input` durable inbox (V2), synthetic user-message injection (background task tool) | Agent-to-agent messages flow through durable swarm message records delivered to the target agent's session input (`steer`/`queue` delivery already exists in V2; V1 gets an equivalent injection). |
| Artifacts | Snapshot shadow repos, `patch` parts, worktrees | Swarm artifact records reference existing artifact kinds: file patches (snapshot hashes), branches/worktrees, task results. No new storage engine. |
| Model policy | Provider catalog, per-provider `whitelist`/`blacklist`, agent `model` field | New `swarm.models.allowed` allowlist enforced by the swarm runtime at spawn time and at session model-switch time for swarm agents. Empty list = no models (fail-closed). |
| Approvals | `PermissionV1` ask/reply engine, `permission.asked/replied` events, TUI permission prompt | New swarm approval keys (`spawn`, `workspace_write`, `dependency_change`, `git_commit`, `git_push`, `merge`, `external_side_effect`) evaluated by the same engine; approvals for high-risk ops surface through the existing prompt UI. |
| Workspaces | `Worktree` service (data-dir worktrees, `opencode/<name>` branches), snapshot service | Swarm workspaces allocate managed worktrees lazily and only for running agents; never 1:1 with logical population. |
| Events/audit | `EventV2` durable events + projectors, SSE endpoints | Swarm state transitions are durable events (`swarm.agent.*`, `swarm.task.*`, `swarm.approval.*`) projected into swarm tables — attribution chain is replayable. |
| Persistence | SQLite/Drizzle, TS migrations in `packages/core` | New swarm tables added via the existing migration pipeline. |
| Config | `ConfigV1.Info` Effect schema + merge pipeline | New `swarm` top-level section (snake_case keys, Effect Schema module `ConfigSwarmV1`), flowing into the generated JSON schema automatically. |

## Module boundary

New workspace package `packages/swarm` (`@opencode-ai/swarm`), allowed to
depend on `@opencode-ai/schema` and `@opencode-ai/core`; never the reverse.
Initial layout (interfaces first, runtime later):

```text
packages/swarm/src/
  agent/       AgentId, AgentRecord, AgentState, AgentRole, AgentParent,
               SpawnRequest, SpawnResult
  scheduler/   scheduling interfaces (admission, active bound)
  task/        TaskId, TaskRecord (mission → tasks)
  messaging/   AgentMessage
  artifacts/   Artifact
  models/      ModelPolicy (allowlist resolution + enforcement types)
  approvals/   ApprovalRequest
  policy/      AgentBudget, swarm policy evaluation (pure)
  workspace/   workspace allocation interfaces
  events/      swarm event definitions (EventV2-compatible)
```

Phase-4 scope is types + pure policy logic only; no runtime, no services.

## Configuration contract (Phase 5)

`swarm` section in `opencode.json` (snake_case to match existing keys):

```jsonc
{
  "swarm": {
    "enabled": true,              // default false — opt-in
    "max_agents": 10000,          // global logical population cap
    "max_active_agents": 32,      // concurrent executing agents
    "max_depth": 12,              // max nesting below primary agent
    "max_children_per_agent": 500,
    "models": {
      "allowed": []               // "provider/model" IDs; EMPTY = no models (fail-closed)
    },
    "approval": {                 // allow | ask | deny, evaluated by the permission engine
      "spawn": "allow",
      "workspace_write": "allow",
      "dependency_change": "ask",
      "git_commit": "ask",
      "git_push": "ask",
      "merge": "ask",
      "external_side_effect": "ask"
    }
  }
}
```

Semantics decided:

- `enabled: false` (default) → swarm tools are not registered; zero behavior
  change vs upstream OpenCode.
- Empty `models.allowed` → spawning agents that need a model fails with an
  explicit error naming the config key. It never falls back to "all models".
- `approval` values map onto permission rules for swarm agents; existing
  OpenCode permission semantics (`read`, `edit`, `bash`, ...) are preserved
  untouched.
- Budgets are instance-global. `max_agents` counts all non-retired agents;
  retired/completed agents can be pruned to free population accounting only
  through explicit runtime accounting rules (later phase).

## Phases

1. **Bootstrap (this run)** — docs, invariants, careful rebrand, swarm
   package skeleton with core types, `swarm` config schema + tests,
   `openswarm` CLI entry alias. No runtime changes.
2. **Swarm runtime core** — durable agent records + events (SQLite migration
   via core pipeline), budget accounting service, spawn request validation
   (policy → budget → record), state machine transitions. Still no LLM
   involvement.
3. **Execution bridge** — scheduler admitting queued agents to OpenCode
   sessions (`SessionPrompt.prompt` on V1 path), `spawn_agent`/`list_agents`/
   `cancel_agent` tools registered for the primary agent when
   `swarm.enabled`, model allowlist enforcement at spawn + model switch.
4. **Messaging & coordination** — `send_agent_message`, `wait_for_agents`,
   durable delivery into session inboxes; completion propagation to parents.
5. **Governance & workspaces** — approval keys wired through the permission
   engine and TUI, worktree-backed workspaces for running agents, artifact
   records, attribution views in TUI.
6. **Scale hardening** — pruning/retirement, budget reclamation, metrics,
   load testing toward the 10,000-agent population with small active bounds.

## Phase status

Implemented in `packages/swarm` so far (pure policy + an in-process runtime
kernel, no upstream invasive rewrites; durable SQLite and the OpenCode
session bridge remain future work):

- **Contracts & policy (pure):** agent state machine with legal transitions,
  budget accounting (`SwarmBudget`), model allowlist fail-closed resolution
  (`SwarmModels`), approval engine with R0–R4 risk categories and scoped
  grants (`SwarmApproval`), review schema + accept gate (`SwarmReview`),
  finding dedup clustering (`SwarmDedup`), lease/conflict control
  (`SwarmConflict`), project census schema (`SwarmCensus`), bounded retry
  policy (`SwarmRecovery`), audit log with redaction (`SwarmAudit`),
  provenance `/why` builder (`SwarmProvenance`), provider seam + scripted
  fake provider (`SwarmProvider`), workspace backend seam (`SwarmWorkspace`).
- **Runtime kernel (`SwarmRuntime`):** mission + census lifecycle, recursive
  spawn through budget + model policy + approval, scheduler with bounded
  active/workspace concurrency and genuine workspace-slot blocking,
  tool dispatch (finding / patch / review / integration / high-risk),
  review swarms (read-only reviewers), approval blocking + grants, patch
  artifacts with provenance, integration ledger gated on approval, `/why`
  viewer, pause/cancel/mailbox injection.
- **Distributed control plane (`ControlPlane` + `WorkerNode`):** durable
  store-backed worker registration/credentials, lease lifecycle, global
  atomic accounting (population, active, LLM, workspaces), idempotent agent
  runs, capability-based worker routing, cluster metrics + chaos harness.
- **Model routing & resource governance:** model catalog + semantic pools
  (`SwarmModelCatalog`, `SwarmPools`) built strictly from the human allowlist;
  pure router (`SwarmModelRouter`) with prefer-cheapest / -lowest-latency /
  -strongest / balanced / explicit-only policies, capability + context-aware
  selection, authorized-only fallbacks, `model.selected` audit events;
  rate-limit governor (`SwarmGovernor`) with global/provider/model
  concurrency + requests-per-window + token throughput that QUEUES (never
  hard-fails) throttled agents with backoff; operational model health
  (`SwarmModelHealth`) where auth failures are terminal; mission budgets
  (`SwarmMissionBudget`) with soft-warn/hard-stop thresholds and human
  budget-increase approvals; atomic child-budget delegation
  (`SwarmChildBudget` + DurableStore atomic ops) that children can never
  mint or duplicate; TUI foundation (`SwarmRegistry`) exposing Models +
  Resource views.
- **Simulation (`SwarmSimulation`):** 10,000-agent stress run (bounded
  resources, zero paid LLM calls) plus a deterministic stress scenario
  covering mailbox traffic, cancellation, approval blocking, artifacts,
  and bounded retries. See `test/swarm.test.ts` for the recorded metrics.
- **Router stress:** `test/router-stress.test.ts` runs 50k pure routing
  decisions and 5,000 logical agents (plus a 2,000-agent cluster run) with
  zero paid LLM traffic; `test/rate-limit.test.ts` proves global + per-model
  concurrency holds across workers; `test/budget.test.ts` proves hard limits
  stop scheduling, human increases resume, and child budgets cannot
  duplicate.

Not yet built (documented technical debt):
- durable SQLite persistence for the LOCAL kernel (schema/DDL prepared in
  `src/schema.ts`; the distributed store's SqliteStore covers cluster mode)
- real provider bridge to `@opencode-ai/llm` / V1 `ai` SDK
- worktree backend using OpenCode's `Worktree` service
- real-repository census scanner (auto-build `SwarmCensus.Info` from a repo)
- wiring the TUI overlay to the distributed `ControlPlane` cluster metrics
  (the overlay currently renders the in-process kernel via `SwarmBridge`; the
  worker/approval/provenance shapes already match the control-plane surface)

## Phase 3 status

TUI/UX for large swarms (`packages/tui/src/swarm`), built on the queryable
state from Phase 2 (`SwarmRegistry.modelsView()` / `resourceView()`):

- **Swarm overlay** (`/swarm`, `<leader>s`): full-screen operational layer that
  layers on top of the primary chat without replacing it — tabs for Overview,
  Agents, Tasks, Approvals, Artifacts, Models, Workers, Activity, Budget, Why.
- **Compact status bar**: one line under the app (`SWARM N agents │ X active │
  Y approvals`), toggled via `/swarm toggle status`.
- **Hierarchy tree** (Agents tab): collapsible Primary → children with
  descendant counts, expand/collapse/filter (state/model/text)/paginate/jump,
  rendered from an O(n) indexed projection (`state/tree.ts`).
- **Agent detail**: id/state/role/parent/children/model/tasks/artifacts/
  waiting-for + message/cancel/cancel-branch/inspect actions (message goes
  through the human→agent mailbox).
- **Tasks / artifacts / reviews**: first-class lists with per-row detail.
- **Approval inbox**: severity-sorted (HIGH/MEDIUM/LOW), detail with risk +
  affected resources, actions Approve once / Approve scope / Modify scope /
  Reject / Ask primary agent; integration approvals expand into a consolidated
  review (files, +/- lines, patches, tests, reviews, conflicts, risk).
- **Activity stream**: curated human-relevant events (findings, patches,
  reviews, approvals, budgets, worker/model health) with severity markers,
  never raw internal model chatter.
- **Human overrides**: pause/resume, cancel agent/branch, change active bound,
  change mission budget limits, disable/enable model — all routed through the
  kernel's own guards.
- **Emergency stop**: pauses scheduling, cancels non-executing work, blocks
  further mutations, preserves state + audit log, allows post-stop inspection.
- **/why provenance**: mission → task → agent → artifact → reviews → approval →
  integration chain rendered from the audit log.
- **Primary agent summaries**: concise operational lines (N findings, M fixes
  ready, K approvals needed, budget %).
- **Performance**: measured at 10k agents / 30k audit events — snapshot build
  ~14-18 ms, first tree page ~0.7 ms, jump-to-agent ~0.5 ms, index-based state
  filter ~1.5 ms. Rendering only materializes the current page of rows.
- **Tests**: `packages/tui/test/swarm` — tree/collapse/filter/jump at 10k,
  approval flow, emergency stop, model disable, budget exhaustion/raise,
  worker lanes, /why, integration review, plus perf assertions.
- **Small kernel additions** (packages/swarm): `setActiveBound`,
  `setMissionBudgetLimits` (human overrides), `purgeCancelled` made public for
  emergency stop, and `handleRequestReview` falls back to the agent's latest
  artifact when none is named.

Remaining rough edges: the overlay is driven by an in-process demo bridge
(seed + fake provider) until the control-plane transport is wired; `/agent
<id>` args are not plumbed through the slash palette (opens the Agents tab to
filter); worker drain/offline are control-plane actions not available on the
local lanes; `bun install` must regenerate the lockfile on a connected machine.

## Compatibility commitments

- `opencode` binary, `opencode.json` config name, `.opencode` directories,
  `OPENCODE_*` env vars, `@opencode-ai/*` package names, DB file names,
  HttpApi identifiers, and the `task` tool all remain functional.
- Upstream `dev` stays mergeable: swarm code lives in new files/packages and
  additive config/tool registration; no invasive rewrites of upstream paths.
- The MIT license and OpenCode copyright notices are preserved.
