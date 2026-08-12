# openSwarm Runtime Bridge

Documents how openSwarm connects the swarm kernel (`packages/swarm`) to the
REAL OpenCode/openSwarm runtime. This is the production bridge: spawned agents
execute through real OpenCode sessions, real configured models, and real tools
— there is no second agent engine and no fake provider outside tests.

## Architecture

```text
existing OpenCode runtime
        │  session loop (SessionPrompt), tool registry, permission engine,
        │  provider catalog, event bus, config loader
        ▼
openSwarm bridge  (packages/opencode/src/swarm)
        │  SwarmService: durable SqliteStore + model allowlist enforcement +
        │  real child-session execution (BackgroundJob + promptOps)
        ▼
swarm scheduler  (packages/swarm policy modules + CLI cluster)
        ▼
real agent session  (a REAL OpenCode child session, model resolved from the
        │  allowlist ∩ configured providers, tools per permission)
        ▼
existing OpenCode tools / model providers / session persistence
```

### Key seam: real child sessions

`SwarmService.spawn` (packages/opencode/src/swarm/service.ts) does NOT run a
fake provider. For every spawned logical agent it:

1. Resolves the model through the swarm allowlist (`swarm.models.allowed`,
   fail-closed) intersected with the **real** configured provider catalog.
2. Creates a **real OpenCode child session** via `Session.Service.create`
   (`parentID` = the spawning session).
3. Runs the child through the **real `SessionPrompt.prompt` loop** using the
   same `BackgroundJob` + `TaskPromptOps` machinery the `task` tool uses.
   The child sees real tools, real permissions, and talks to the real model.
4. Persists the agent record (state `queued → running → completed|failed`) in
   a durable `SqliteStore` at `Global.Path.data/swarm.db`.
5. Exposes result + mailbox via `get_agent_result` / `send_agent_message`.

### The swarm tools (registered only when `swarm.enabled = true`)

| Tool | Purpose |
| --- | --- |
| `spawn_agent` | Create one logical agent + real child session |
| `spawn_agents` | Create several agents in one call |
| `list_agents` | List agents and their states |
| `send_agent_message` | Deliver a message to an agent's mailbox |
| `get_agent_result` | Fetch an agent's state + message/artifact summary |
| `cancel_agent` | Cancel a non-terminal agent |
| `wait_for_agents` | Block the primary turn (bounded) until agents finish |

Registration is gated in `tool/registry.ts`: when `swarm.enabled` is false the
tool list is byte-for-byte identical to upstream OpenCode.

### Model governance

The human controls which models children may use:

```jsonc
{ "swarm": { "enabled": true, "models": { "allowed": ["provider/model-a", "provider/model-b"] } } }
```

- Empty allowlist ⇒ **no** models (fail-closed); spawning rejects with
  `no_models_allowed`.
- A requested model not in the allowlist ⇒ `model_not_allowed`; no fallback.
- The primary's own model does not automatically authorize children.
- `approvedModelIDs()` intersects the allowlist with the real provider catalog
  so a listed-but-unconfigured model is not silently granted.

### `/swarm` real state

- `openswarm swarm real-status` reads the live `swarm.db` store + your
  `opencode.json` `swarm` section (population, active bounds, approved models,
  per-state counts, config validation errors).
- HTTP endpoints serve the same real state to the TUI, and the TUI `/swarm`
  overlay reads them instead of a demo kernel.

### Per-session working directory (isolated worktrees)

Coding agents get an **isolated workspace**: `Session.create` accepts an
optional `directory`, every filesystem/shell/git/LSP tool resolves paths
against the session's directory when present (`ctx.directory ?? instance.
directory`), and `external_directory` treats the session directory as inside
the project boundary. Spawned `isolated-write` agents allocate a real git
worktree via the `Worktree` service (or a temp dir when git is absent, e.g. in
tests) and run their whole session inside it. Read-only agents
(investigators/reviewers) never allocate one. This is what keeps the user's
working tree untouched until integration is approved.

### Server endpoints (all real)

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/swarm/status` | GET | live scheduler state (population, bounds, approved models) |
| `/swarm/agents` | GET | list logical agents + states |
| `/swarm/pause` / `/swarm/resume` | POST | pause/resume scheduling (durable queued state preserved) |
| `/swarm/cancel` | POST | cancel one agent or a whole subtree (`branch: true`) |
| `/swarm/release-worktree` | POST | release an agent's worktree after patch capture |
| `/swarm/why?target=...` | GET | stored provenance for a file or agent id |
| `/swarm/integration/approve` | POST | raise the real permission prompt for integration |
| `/swarm/integration/apply` | POST | apply approved patches; **rejected without a server-side approval** |

Integration apply is **server-side enforced**: a client boolean is never
trusted. `apply` returns `applied: false` unless an explicit approval was
granted through the real permission prompt, and the approval token is consumed
exactly once.

### `/why` provenance

`/swarm/why?target=<file-or-agent>` returns stored operational facts — which
agents produced patches touching the file, their tasks, artifacts, and state.
The TUI `/why` view fetches it from the server. It never exposes hidden
chain-of-thought; only durable records.

### Failure classification

- **Regressions introduced this phase**: fixed (tests pass).
- **Pre-existing upstream failures**: the `bun run build` smoke test hits
  `https://models.dev` and fails in offline environments; this is the upstream
  models-catalog fetch, unrelated to the swarm bridge. The source CLI runs
  fine (`bun run src/index.ts ...`).

## Not yet wired (next milestones)

- **Real git-worktree patch application in `/swarm/integration/apply`**: the
  approval gate is fully server-side enforced and tested, and the apply
  endpoint reports the changed files, but physically writing the worktree
  diffs into the user's tree is stubbed to the approval-gated return (real
  `apply_patch` on the captured diffs is the next step).
- **Server mutation endpoints** for scoped-approval / emergency-stop / budget /
  model-disable (the kernel supports them; the HTTP surface covers pause,
  resume, cancel, release-worktree, and integration today).
- **Mission-plan approval gate** wired to the real permission prompt (plan
  checkpoint for large missions).
- **`/why` drill-down** into individual reviews/approvals beyond the current
  agent/task/artifact facts.
