export * as SwarmConfigBridge from "./config"

import { SwarmConfig } from "@opencode-ai/swarm/config/config"
import { ConfigSwarmV1 } from "@opencode-ai/core/v1/config/swarm"

// ---------------------------------------------------------------------------
// Bridge from the user-facing `opencode.json` swarm section (ConfigSwarmV1,
// all fields optional, no max_active_coding_workspaces yet) to the richer
// runtime `SwarmConfig.Info` used by packages/swarm. The runtime config keeps
// the documented defaults (see SwarmConfig.DEFAULT) and NEVER silently enables
// all configured models: models.allowed is fail-closed.
// ---------------------------------------------------------------------------

export interface SwarmConfigError {
  readonly message: string
}

// Validate the user-facing swarm section at startup. Returns errors, never
// throws. Callers print a clear, actionable message and disable the swarm.
export function validateSwarmConfig(input: ConfigSwarmV1.Info | undefined): SwarmConfigError[] {
  if (input === undefined) return []
  const errors: SwarmConfigError[] = []
  if (input.enabled === true && (input.models?.allowed === undefined || input.models.allowed.length === 0)) {
    errors.push({
      message:
        "Swarm is enabled but no child models are authorized.\n" +
        'Configure "swarm.models.allowed": ["provider/model", ...] before agents can spawn.',
    })
  }
  return errors
}

export function resolveApproval(
  value: ConfigSwarmV1.Info["approval"],
): SwarmConfig.ApprovalConfig {
  const d = SwarmConfig.DEFAULT.approval
  return {
    spawn: value?.spawn ?? d.spawn,
    workspace_write: value?.workspace_write ?? d.workspace_write,
    dependency_change: value?.dependency_change ?? d.dependency_change,
    git_commit: value?.git_commit ?? d.git_commit,
    git_push: value?.git_push ?? d.git_push,
    merge: value?.merge ?? d.merge,
    external_side_effect: value?.external_side_effect ?? d.external_side_effect,
    mission_plan: d.mission_plan,
    integration: d.integration,
    budget_increase: d.budget_increase,
  }
}

// Build the runtime swarm config from the user's opencode.json swarm section.
// Unset values fall back to SwarmConfig.DEFAULT. models.allowed defaults to
// [] (fail-closed) — never to "all configured models".
export function swarmConfigFromV1(input: ConfigSwarmV1.Info | undefined): SwarmConfig.Info {
  if (input === undefined) return { ...SwarmConfig.DEFAULT }
  const d = SwarmConfig.DEFAULT
  return {
    enabled: input.enabled ?? d.enabled,
    max_agents: input.max_agents ?? d.max_agents,
    max_active_agents: input.max_active_agents ?? d.max_active_agents,
    max_active_coding_workspaces: d.max_active_coding_workspaces,
    max_depth: input.max_depth ?? d.max_depth,
    max_children_per_agent: input.max_children_per_agent ?? d.max_children_per_agent,
    models: {
      ...d.models,
      allowed: input.models?.allowed ? [...input.models.allowed] : [],
    },
    approval: resolveApproval(input.approval),
    budget: d.budget,
  }
}