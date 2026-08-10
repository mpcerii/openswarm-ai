# openSwarm Core Invariants

These invariants are NON-NEGOTIABLE. Every swarm feature, refactor, and pull
request must preserve them. They are mirrored in the root `AGENTS.md` so all
coding agents see them.

## 1. One user-facing primary agent

The human normally talks to exactly one primary agent (internally the "root
agent" or "primary agent"). The product UI presents it as the normal coding
agent — OpenCode's `build` agent and its workflow stay intact. No forced
Emperor/General terminology in product architecture. The hierarchy beneath it
is dynamic.

## 2. Recursive agent spawning

Any agent may create child agents if its policy permits it.

```text
human
  ↓
primary agent
  ├─ agent
  │   ├─ agent
  │   └─ agent
  ├─ agent
  └─ agent
      └─ ...
```

There are no hard-coded fixed roles (manager/worker/general are not required
tiers). Roles are runtime metadata chosen according to the mission.

## 3. 10,000 logical agents

Target: `max logical population: 10,000`.

This MUST NOT mean 10,000 OS processes, shells, simultaneous LLM requests, or
git worktrees. Agents are lightweight persistent logical actors with states
such as:

```text
created, queued, running, waiting, sleeping, blocked,
awaiting_approval, completed, failed, cancelled, retired
```

Only a bounded number (`maxActiveAgents`) execute simultaneously; the rest
live in durable storage and are scheduled.

## 4. User owns model policy

The human selects which models swarm agents may use (`swarm.models.allowed`).
No agent may bypass this list. Agents may REQUEST an allowed model or a
capability class, but the runtime enforces the allowlist. LLM-provided tool
arguments must never bypass validation — model selection for spawned agents
is checked server-side against the policy, never trusted from tool input.

Fail-closed rule: an empty or missing allowlist means swarm agents get NO
models (spawning that requires a model fails with a clear error). It must
never silently grant access to every configured model.

## 5. Human governance

Low-risk exploration may run automatically per configured permissions.
High-risk operations require human approval. At minimum these are protected:

- dependency installation/removal
- destructive commands
- external side effects
- network actions (when configured)
- git commit (depending on policy)
- git push
- PR creation
- branch deletion
- merging into protected branches
- production operations
- secret access
- migrations with destructive potential

openSwarm reuses OpenCode's permission engine (`ask/allow/deny` rulesets,
`permission.asked`/`replied` flow) for this; swarm adds approval keys on top,
it does not replace the engine.

## 6. Agents never directly merge arbitrary work into main

Coding agents work through isolated changes: patches, branches, or temporary
worktrees (OpenCode already has the `Worktree` service and snapshot shadow
repos). Integration into protected branches must be deliberate and auditable,
performed by the human or via an explicitly approved action.

## 7. Everything must be attributable

Every important action is traceable:

```text
mission → task → agent → tool action → artifact → review → approval → integration
```

Concretely: swarm records are durable (event-sourced like OpenCode's
`EventV2`), every agent stores its parent chain and spawning mission, every
tool action already carries session/agent/message provenance in OpenCode, and
approvals reference the exact request they answered.

## 8. Bounded recursive spawning

Recursive spawn is controlled through non-duplicable, global resource
accounting. A child must not be able to generate unlimited population
capacity. Budgets (population, depth, children-per-agent, active slots) are
checked and atomically consumed by the swarm runtime itself — never by
agents — and are accounted globally per openSwarm instance, not per agent.
