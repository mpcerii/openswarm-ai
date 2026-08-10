# Swarm Package Guide

`@opencode-ai/swarm` defines the hierarchical multi-agent layer of
openSwarm. Read `docs/openswarm/invariants.md` before changing anything here.

## Boundary

- Depends on `@opencode-ai/schema` (and later Core). Schema and Core must
  never depend on this package.
- This package currently holds contracts and pure policy logic only: types,
  branded IDs, budget accounting, and model-policy resolution. No services,
  no I/O, no runtime yet.
- Do not duplicate OpenCode machinery (sessions, permissions, providers,
  events). Swarm types reference OpenCode contracts (e.g. `SessionID`) and
  the runtime will compose them.

## Conventions

- Follow the Schema package rules: same-name interfaces for `Schema.Struct`
  records, branded IDs with `create()` statics, exact prefixes (`swa_`
  agents, `swt_` tasks, `swm_` messages, `swf_` artifacts, `swp_` approvals),
  readonly public contracts, `optional(...)` helper for optional fields.
- One canonical module per domain directory with the self-reexport pattern
  (`export * as SwarmAgent from "./agent"`).

## Non-negotiables enforced here

- `SwarmModels.resolve` is fail-closed: an empty allowlist returns
  `no_models_allowed`; unknown models return `model_not_allowed`. Never add a
  fallback that grants unlisted models.
- `SwarmBudget.evaluateSpawn` / `canAdmit` are pure and must stay pure;
  accounting state is supplied by the runtime, never mutated here.
