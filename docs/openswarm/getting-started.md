# openSwarm Getting Started

This page contains the exact, tested commands to install, configure, launch,
and verify openSwarm as a real multi-agent coding CLI.

## Prerequisites

- **Bun** >= 1.3 (this repo is a Bun monorepo; `packageManager: bun@1.3.14`).
- A **configured LLM provider** (API key in `~/.local/share/opencode/auth.json`
  via `openswarm auth login`, or a provider in `opencode.json`).
- Network access to your model provider at runtime.

## 1. Install dependencies

```bash
cd openSwarm
bun install
```

## 2. Configure a provider

If you have not configured a provider yet, log in (upstream OpenCode flow):

```bash
openswarm auth login
```

You can also declare a provider directly in `opencode.json` (see upstream docs
for the provider schema).

## 3. Enable swarm + authorize child models

Create/update `opencode.json` in the **repository root** (the directory you
launch from, or any parent — config discovery walks UP from the working
directory, so `bun run --cwd packages/opencode src/index.ts` still loads
`openSwarm/opencode.json` from the repo root).

```jsonc
{
  // Your normal coding model for the primary agent:
  "model": "anthropic/claude-sonnet-4",

  "swarm": {
    "enabled": true,
    "max_agents": 10000,
    "max_active_agents": 32,
    "max_depth": 12,
    "max_children_per_agent": 500,
    "models": {
      // ONLY these models are available to spawned agents.
      // Empty = agents may use NO models (fail-closed).
      "allowed": [
        "anthropic/claude-sonnet-4",
        "openai/gpt-5"
      ]
    },
    "approval": {
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

Important: the primary agent's `model` is NOT automatically available to
children. Spawned agents may only use ids listed in `swarm.models.allowed`.

If you enable swarm without listing any models, the CLI prints a clear warning
and spawning agents fails with `no_models_allowed`.

## 4. Launch the CLI

```bash
# From the monorepo (dev):
bun run --cwd packages/opencode src/index.ts

# Or once built (see note below on the offline build caveat):
./path/to/built/opencode
```

The TUI is the full interactive client. The primary coding agent (the normal
`build` agent) keeps working exactly as upstream.

## 5. Verify `/swarm`

In the TUI, type:

```text
/swarm
```

You should see real scheduler state — population, active bound, approved
models (with availability), and per-state agent counts — read from the live
server. Zero counts (e.g. `Population: 0 / 10000`) are valid state, not an
error. This is NOT demo data.

If swarm is enabled but no model is usable, the overlay shows a precise
diagnostic (e.g. "swarm config: Swarm is enabled but no child models are
authorized…") instead of a bare "missing data".

You can also verify from the shell:

```bash
openswarm swarm real-status
```

which prints the same real state as JSON (including any config validation
errors).

## 6. Run a small multi-agent task

Paste this into the TUI:

```text
> Inspect this repository for the failing auth test, delegate the investigation
> to a spawned investigator agent, and report what it finds. Do not change any
> files.
```

The primary agent can use `spawn_agent` to create a real child session that:

- executes through the **real** OpenCode session loop,
- uses a model from `swarm.models.allowed` (governed fail-closed),
- runs the real coding tools (read/grep/glob/…) per its permissions,
- reports back via `get_agent_result` / a compact summary.

Use `list_agents`, `send_agent_message`, `get_agent_result`, `cancel_agent`,
and `wait_for_agents` to orchestrate from the primary conversation.

## 7. Build the binary (note the offline caveat)

```bash
bun run build   # in packages/opencode
```

The build compiles a `dist/opencode-<os>-<arch>/bin/opencode` binary. In an
**offline environment** the post-build smoke test (which fetches the upstream
model catalog from `https://models.dev`) fails; that is a pre-existing
upstream behavior unrelated to the swarm bridge. The CLI runs fine from source
(`bun run src/index.ts`) and from the compiled binary when network is
available.

## Test suite (verified)

```bash
cd packages/swarm && bun test        # 138 pass (incl. 10k-agent simulation)
cd packages/opencode && bun test test/swarm test/tool/task.test.ts   # real-loop E2E
cd packages/tui && bun test test/swarm   # 19 pass
```

Typecheck each package with `bun typecheck` (clean in `swarm`, `opencode`,
`tui`).
