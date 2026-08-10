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

## Compatibility commitments

- `opencode` binary, `opencode.json` config name, `.opencode` directories,
  `OPENCODE_*` env vars, `@opencode-ai/*` package names, DB file names,
  HttpApi identifiers, and the `task` tool all remain functional.
- Upstream `dev` stays mergeable: swarm code lives in new files/packages and
  additive config/tool registration; no invasive rewrites of upstream paths.
- The MIT license and OpenCode copyright notices are preserved.
