# OpenCode Architecture Baseline

Upstream snapshot: `anomalyco/opencode` branch `dev` at commit
`550d1ffd24718454925c4636e937878f0274de48` (cloned 2026-08-10).

This document records how OpenCode works *before* any openSwarm changes, so
future work can be measured against a known baseline. All paths are relative
to the repository root.

## Repository shape

Bun + Turbo monorepo (`packageManager: bun@1.3.14`, workspaces under
`packages/*`). The important packages:

| Package | npm name | Role |
| --- | --- | --- |
| `packages/opencode` | `opencode` | Production CLI/TUI host: yargs CLI, instance server, legacy ("V1") session runtime, tools, agents, permissions, config loader |
| `packages/core` | `@opencode-ai/core` | Domain core: database, EventV2, sessions (V2), agents (V2), permissions (V2), providers/models, snapshots, git, locations |
| `packages/schema` | `@opencode-ai/schema` | Leaf Effect-Schema datatypes shared by everything (no runtime deps) |
| `packages/protocol` | `@opencode-ai/protocol` | Public V2 `HttpApi` group definitions (paths, payloads, SSE streams) |
| `packages/server` | `@opencode-ai/server` | V2 server handlers/routes hosting the protocol API |
| `packages/llm` | `@opencode-ai/llm` | Native LLM protocol stack (openai-chat/responses, anthropic, gemini, bedrock) |
| `packages/plugin` | `@opencode-ai/plugin` | Plugin type definitions (server hooks + TUI plugin API) |
| `packages/tui` | `@opencode-ai/tui` | Terminal UI: SolidJS rendered through opentui (TypeScript, no Go) |
| `packages/client`, `packages/sdk`, `packages/sdk-next` | `@opencode-ai/*` | Generated Promise/Effect clients and embedded SDK |
| `packages/cli` | `@opencode-ai/cli` | Preview "2.0" CLI (`lildax`) hosting the V2 server |
| `packages/effect-drizzle-sqlite`, `packages/effect-sqlite-node` | vendored | Effect↔Drizzle SQLite adapters |

Dependency direction (enforced by convention, see root `AGENTS.md`):
Schema → Core/Protocol → Server; client code may use Schema+Protocol only.

Two parallel runtime architectures coexist:

- **V1 (production path)** — `packages/opencode`: `SessionPrompt` loop,
  `PermissionV1`, agents built in `src/agent/agent.ts`, served through the
  instance `HttpApi` (`opencode-instance`) and rendered by the TUI.
- **V2 (successor)** — `packages/core` + `packages/server`: event-sourced
  sessions, durable prompt inbox, `PermissionV2`, exposed through
  `packages/protocol` (`/api/...`). The `V2` suffix is being normalized away
  as contracts stabilize (`packages/schema/AGENTS.md`).

openSwarm must keep **both** working; the swarm layer extends V1 first
(because that is what the shipped CLI runs) while staying compatible with V2
direction.

## Primary agents

- Agent definition (V1): `Agent.Info` schema in
  `packages/opencode/src/agent/agent.ts:35-55` — fields: `name`,
  `description`, `mode: "subagent" | "primary" | "all"`, `native`, `hidden`,
  `permission` (a `PermissionV1.Ruleset`), `model`, `variant`, `prompt`,
  `options`, `steps`, sampling params.
- Built-in agents are declared inline in the agent service state builder
  (`agent.ts:140-265`):
  - `build` — `mode: "primary"`, the default coding agent.
  - `plan` — primary, plan-mode restrictions (denies `task.general`, limits
    `edit` to plan files).
  - `general` — `mode: "subagent"`, general-purpose task agent.
  - `explore` — `mode: "subagent"`, read-only codebase explorer.
  - `compaction`, `title`, `summary` — hidden primary utility agents.
- Custom agents come from config (`agent` key in `opencode.json`, or
  `agent/**/*.md` / `mode/**/*.md` markdown files in `.opencode` dirs),
  merged over defaults at `agent.ts:267-310`. `disable: true` removes an
  agent. User permission rules are appended last, so user rules win.
- Default agent selection: `cfg.default_agent` if valid, else first visible
  non-subagent agent (`agent.ts:328-340`). Per-session agent is stamped from
  each prompt's user message (`session/prompt.ts:635-689`) and re-read from
  the last user message each loop iteration (`prompt.ts:1170`).
- V2 agents: `packages/schema/src/agent.ts` (`AgentV2.Info`) and
  `packages/core/src/agent.ts`; built-ins defined by `AgentPlugin`
  (`packages/core/src/plugin/agent.ts:100-206`) and config/markdown agents by
  `ConfigAgentPlugin` (`packages/core/src/config/plugin/agent.ts`).

## Subagents / tasks (the existing "swarm seed")

- The `task` tool (`packages/opencode/src/tool/task.ts`) is the only spawn
  mechanism today:
  - Params: `description`, `prompt`, `subagent_type`, optional `task_id`
    (resume), optional `background` (experimental flag
    `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`).
  - **Depth limit**: walks the `parentID` chain; fails when
    `depth >= cfg.subagent_depth ?? 1` (`task.ts:104-117`; config key defined
    in `packages/core/src/v1/config/config.ts:84-86`). Default 1 means
    subagents cannot spawn further subagents.
  - Asks the `task` permission with the agent name as pattern
    (`task.ts:119-129`).
  - Child session permission is *derived*: parent session's deny rules +
    external_directory rules, plus default denies
    (`agent/subagent-permissions.ts:14-27`).
  - Creates a child session with `parentID = ctx.sessionID`
    (`task.ts:156-172`), then runs a full `SessionPrompt.prompt` on the child
    via injected `TaskPromptOps` (`task.ts:200-214`).
  - Foreground result: last text part of the child session, wrapped in a
    `<task>` XML envelope (`task.ts:64-79`). Background mode injects the
    result into the parent as a synthetic user message on completion.
- Parent/child link is `session.parent_id` (`packages/core/src/session/sql.ts:31`).
- **No concurrency limit exists** for subagents today; only depth. There is
  no population accounting, no scheduler, no message bus between agents.

## Sessions

- V1 storage: SQLite tables `session`, `message`, `part`
  (`packages/core/src/session/sql.ts`). `Session.Info`
  (`packages/opencode/src/session/session.ts:224-244`) carries `parentID`,
  `agent`, `model`, `permission` (session-level ruleset), cost/token
  counters, `revert` state.
- Writes are event-sourced: mutations publish `SessionV1.Event.*` through
  `EventV2Bridge`; `SessionProjector` (`packages/core/src/session/projector.ts`)
  projects them into SQLite rows and accumulates cost/tokens.
- Execution loop (V1): `SessionPrompt.loop` →
  `SessionRunState.ensureRunning(sessionID, ...)` guarantees one run per
  session; `runLoop` (`session/prompt.ts:1081-1341`) iterates provider steps:
  load messages → handle pending subtasks/compaction → resolve agent →
  create assistant message → build tools + system context →
  `SessionProcessor` streams the LLM (`ai` SDK by default; native `llm`
  package behind `OPENCODE_EXPERIMENTAL_NATIVE_LLM`) → tool calls executed
  with doom-loop detection → next step or stop.
- V2 sessions: `packages/core/src/session.ts` — durable `session_input`
  admission (`SessionInput.admit`), advisory `SessionExecution.wake`,
  process-local `SessionRunCoordinator` (serializes per session, concurrent
  across sessions), Location-scoped `SessionRunner` with exactly one
  `llm.stream(request)` per provider turn. Durable events +
  `session_message` table.

## Tool execution

- Tool registry (V1): `packages/opencode/src/tool/registry.ts`. Built-ins:
  `bash` (shell), `read`, `write`, `edit`, `apply_patch`, `glob`, `grep`,
  `task`, `webfetch`, `websearch`, `todowrite`, `question`, `skill`,
  `lsp` (flag), `plan_exit` (flag), `execute` (experimental code mode),
  `invalid`.
- `Tool.define(id, init)` (`tool/tool.ts:151-169`); execution wrapper decodes
  params (zod→JSON Schema at plugin boundaries) and truncates output.
- Agent tool filtering happens at request time:
  `Permission.disabled(tools, merge(agent.permission, session.permission))`
  hides tools whose permission key has a wildcard deny
  (`session/llm/request.ts:208-214`, `permission/index.ts:204-214`).
- Dynamic tools: local `tool(s)/*.{js,ts}` in config dirs, plugin `tool`
  hooks, MCP tools (`session/tools.ts`).
- V2: `packages/core/src/tool/` — `ToolRegistry.materialize(permissions)`
  derives model-visible definitions; authorization happens inside each tool
  via `PermissionV2.assert`.

## Permissions

- V1 model: `Rule = {permission, pattern, action}` with
  `action = allow | deny | ask`; `Ruleset = Rule[]`
  (`packages/schema/src/v1/permission.ts`). Evaluation = last matching rule
  wins (`findLast` + wildcard match, default `ask`)
  (`packages/opencode/src/permission/index.ts:28-38`).
- Tool-time flow: tool calls `ctx.ask({permission, patterns, ...})` →
  `Permission.ask` evaluates merged `[agentRuleset, sessionRuleset, approved]`;
  `deny` fails immediately, `ask` publishes `permission.asked`, blocks on a
  Deferred until the UI replies (`once | always | reject`). `always` appends
  to an in-memory approved list (per instance lifetime). Reject cascades to
  all pending requests of the session.
- Known permission keys: `read, edit, glob, grep, list, bash, task,
  external_directory, todowrite, question, webfetch, websearch, lsp,
  doom_loop, skill` (+ `plan_enter`/`plan_exit`).
- Config format: top-level `permission` key, either a global action or
  `{key: action | {pattern: action}}`
  (`packages/core/src/v1/config/permission.ts`).
- V2 model: `action/resource/effect` vocabulary, persisted "always" rules in
  the `permission` table (`packages/core/src/permission/saved.ts`),
  `PermissionV2.assert` at tool execution.

## Models / providers

- Catalog source: models.dev (`packages/core/src/models-dev.ts`) fetched from
  `https://models.opencode.ai` (override `OPENCODE_MODELS_URL`), cached in
  `Global.Path.cache/models.json`.
- Provider assembly (`packages/opencode/src/provider/provider.ts:1343-1668`):
  models.dev catalog → plugin `provider.models` hooks → config `provider`
  entries → env-var keys → stored auth.json keys → plugin auth loaders →
  built-in integrations (anthropic, openai, copilot, bedrock, vertex, ...).
- User-facing levers: `model` ("provider/model"), `small_model`,
  `enabled_providers` / `disabled_providers`, and per-provider
  `whitelist` / `blacklist` model ID lists
  (`packages/core/src/v1/config/provider.ts:82-126`). Whitelist/blacklist are
  the closest existing analog to a swarm model allowlist, but they are
  per-provider and applied to the *catalog*, not per-agent enforcement.
- Resolution: `Provider.parseModel` splits on first `/`; `getModel` fails
  with fuzzy suggestions. Agent models resolve through the same path.
- Auth: `Global.Path.data/auth.json` (mode 0600); OAuth/API flows via
  `ProviderAuth` + plugin auth hooks.

## Configuration

- Files: `opencode.json` / `opencode.jsonc` discovered walking up from cwd;
  `.opencode/` directories (project chain + `~/.opencode`); global config in
  XDG config dir (`opencode.jsonc|opencode.json|config.json`); managed
  enterprise config (`/etc/opencode`, `ProgramData\opencode`, MDM plist) and
  remote wellknown/console configs. Env overrides: `OPENCODE_CONFIG`,
  `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR`, `OPENCODE_PERMISSION`,
  `OPENCODE_DISABLE_PROJECT_CONFIG`.
- **Top-level schema**: Effect Schema `ConfigV1.Info` in
  `packages/core/src/v1/config/config.ts:32-190`. Decode options drop unknown
  keys (`onExcessProperty: "ignore"`), so a new top-level section must be
  added to this schema to survive loading.
- Merge order (low → high): wellknown remote → global file → `OPENCODE_CONFIG`
  → project files → `.opencode` dirs → `OPENCODE_CONFIG_CONTENT` → console
  config → managed dir → macOS MDM (`config/config.ts:314-596`).
- JSON schema for editors is generated from `ConfigV1.Info`
  (`packages/opencode/script/schema.ts`).
- V2 config: `Config.Info` in `packages/core/src/config.ts:29-107`; V1 files
  are detected (`ConfigMigrateV1.isV1`) and migrated.

## Persistence

- SQLite via Drizzle over Effect SqlClient; DB path
  `Global.Path.data/opencode.db` (per-channel suffix for non-release
  channels; override `OPENCODE_DB`) — `packages/core/src/database/database.ts`.
  WAL mode, migrations are TS modules applied by a custom runtime migrator
  (`database/migration.ts`), generated by `bun run migration` in core.
- Tables (baseline `database/schema.gen.ts`): `session`, `message`, `part`,
  `session_message`, `session_input`, `session_context_epoch`, `todo`,
  `event`, `event_sequence`, `permission`, `project`, `project_directory`,
  `workspace`, `account*`, `credential`, `session_share`, `data_migration`.
- Legacy JSON storage tree under `Global.Path.data/storage` (migrated into
  SQLite on first runs).

## Events

- Two layers: process-wide `GlobalBus` (Node EventEmitter,
  `packages/opencode/src/bus/global.ts`) and typed `EventV2`
  (`packages/core/src/event.ts`) with optional durability: durable events get
  a per-aggregate monotonic sequence in `event_sequence`, are committed in a
  single SQLite transaction with projectors, and are replayable
  (`replay/replayAll` with owner claims).
- `EventV2Bridge` re-emits core events onto the GlobalBus, durable ones
  additionally as `sync` envelopes.
- Client exposure: three SSE endpoints — instance `/event`, `/global/event`,
  and public V2 `/api/event` (protocol group `event`).

## TUI

- TypeScript SolidJS over opentui (`packages/tui/src`), rendered in-terminal
  at 60fps; entry `app.tsx`. Connects to the server via SDK + SSE; default
  transport is an in-process worker RPC (`http://opencode.internal`), real
  HTTP when `--port/--hostname` given.
- Session route (`routes/session/index.tsx`) renders messages/parts,
  permission prompts (aggregated over the session *and its subagent
  children*), question dialogs, task/subagent footer and background-subagent
  dialog.
- Branding surface: `packages/tui/src/logo.ts` (glyph art), `app.tsx`
  terminal titles ("OpenCode"), `packages/opencode/src/cli/ui.ts` (ASCII
  wordmark), `src/index.ts` `.scriptName("opencode")`.

## File changes, undo, snapshots

- Git-based *shadow repositories* per project:
  `Global.Path.data/snapshot/<projectID>/<hash(worktree)>` with
  `--git-dir <shadow> --work-tree <worktree>`; seeded from the real repo's
  object DB via alternates (`packages/opencode/src/snapshot/index.ts`).
- Capture points at step start/finish in `session/processor.ts`; a `patch`
  part `{hash, files}` is written to the transcript when files changed.
- Undo: `SessionRevert` (`session/revert.ts`) collects `patch` parts after a
  boundary, selectively `git checkout`s files back, persists session diff and
  revert state; `unrevert` restores. V2 equivalent:
  `packages/core/src/session/revert.ts` (stage/clear/commit durable events).

## Worktrees / git

- V1 `Worktree` service (`packages/opencode/src/worktree/index.ts`) creates
  managed worktrees under `Global.Path.data/worktree/<projectID>/<name>` on
  branches `opencode/<name>`; boot/reset/remove lifecycle with events.
- Core git ops in `packages/core/src/git.ts` (worktree add/remove/list,
  tree capture for snapshots, change capture/apply/discard).
- The bash tool has **no git-specific interception**; git safety is
  prompt-level guidance plus the normal `bash` permission ask.

## Runtime directories

- XDG-based (`packages/core/src/global.ts`): data/cache/config/state/tmp all
  under an `opencode` folder name; per-project config dir is `.opencode/`.
- Many `OPENCODE_*` env vars are load-bearing (flags in
  `packages/core/src/flag/flag.ts`).

## Plugin architecture

- `Plugin = (input) => Promise<Hooks>` (`packages/plugin/src/index.ts:74`).
  Hooks include `event`, `config`, `tool`, `auth`, `provider.models`,
  `chat.message/params/headers`, `permission.ask`, `tool.execute.before/after`,
  `shell.env`, `experimental.chat.*`, `tool.definition`.
- Loading: npm specifiers or local files, from config `plugin` entries and
  auto-discovered `.opencode/plugin(s)/`; `--pure` disables external plugins.
- Built-in internal plugins ship provider integrations (copilot, codex,
  gitlab, cloudflare, ...).
- TUI plugins: separate `TuiPlugin` type with routes, slots, keymaps, kv.

## Tests / tooling

- Tests run per package with `bun test` (never from root; guard
  `do-not-run-tests-from-root`). Core tests in `packages/core/test/*`,
  opencode tests in `packages/opencode/test/*`.
- Typecheck: `bun typecheck` per package (`tsgo --noEmit`); root
  `bun typecheck` runs turbo across packages.
- Lint: `oxlint` at root (`.oxlintrc.json`).
- CLI build: `packages/opencode/script/build.ts` (Bun compile per platform).
