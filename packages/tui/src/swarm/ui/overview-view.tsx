import { For, Show, createMemo } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { useSwarm } from "../context"
import { compact, fmtTime } from "./common"
import type { SwarmTab, OverlayStore, OverlayActions } from "./overlay"
import type { SetStoreFunction } from "solid-js/store"

export function OverviewView(props: {
  store: OverlayStore
  setStore: SetStoreFunction<OverlayStore>
  actions: OverlayActions
  height: number
}) {
  const { theme } = useTheme()
  const swarm = useSwarm()

  const snapshot = () => swarm.snapshot!
  const mission = createMemo(() => snapshot().missions[0])
  const resources = createMemo(() => snapshot().resources[0])
  const counts = createMemo(() => snapshot().counts)

  const go = (tab: SwarmTab) => props.setStore("tab", tab)

  const stats = createMemo(() => {
    const s = snapshot()
    const c = counts()
    return [
      { label: "mission", value: mission()?.title ?? "—", go: undefined as SwarmTab | undefined },
      { label: "population", value: `${s.agents.length}`, go: "agents" as SwarmTab },
      { label: "active", value: `${c.running}`, go: "agents" as SwarmTab },
      { label: "queued", value: `${c.queued}`, go: "agents" as SwarmTab },
      { label: "waiting", value: `${c.waiting}`, go: "agents" as SwarmTab },
      { label: "blocked", value: `${c.blocked}`, go: "agents" as SwarmTab },
      { label: "completed", value: `${c.completed}`, go: "agents" as SwarmTab },
      { label: "failed", value: `${c.failed}`, go: "agents" as SwarmTab },
      { label: "awaiting approval", value: `${c.awaitingApproval}`, go: "approvals" as SwarmTab },
      { label: "tasks done", value: `${s.tasks.filter((t) => t.state === "completed").length}`, go: "tasks" as SwarmTab },
      { label: "artifacts", value: `${s.artifacts.length}`, go: "artifacts" as SwarmTab },
      { label: "models", value: `${s.models.length}`, go: "models" as SwarmTab },
      { label: "workers", value: `${s.workers.length}`, go: "workers" as SwarmTab },
      { label: "queue depth", value: `${s.queue.length}`, go: "agents" as SwarmTab },
    ]
  })

  const statColor = (label: string) => {
    const c = counts()
    if (label === "failed") return c.failed > 0 ? theme.error : theme.textMuted
    if (label === "active") return c.running > 0 ? theme.success : theme.textMuted
    if (label === "awaiting approval") return c.awaitingApproval > 0 ? theme.warning : theme.textMuted
    if (label === "blocked") return c.blocked > 0 ? theme.warning : theme.textMuted
    if (label === "queued") return c.queued > 0 ? theme.info : theme.textMuted
    return theme.textMuted
  }

  return (
    <box flexDirection="column" gap={1} minHeight={0} flexGrow={1}>
      <Show when={snapshot().emergencyStopped}>
        <box border={["top", "bottom"]} borderColor={theme.error} paddingLeft={1}>
          <text fg={theme.error} attributes={TextAttributes.BOLD}>
            ⛔ EMERGENCY STOP ACTIVE — scheduling halted, swarm state preserved.
          </text>
          <text fg={theme.error} onMouseUp={() => props.actions.resumeFromStop()}>
            {" "}
            Resume{" "}
          </text>
          <text fg={theme.error}>to release.</text>
        </box>
      </Show>
      <Show when={snapshot().paused && !snapshot().emergencyStopped}>
        <box paddingLeft={1}>
          <text fg={theme.warning}>Swarm is PAUSED (scheduler halted, state preserved).</text>
        </box>
      </Show>
      <box paddingLeft={1}>
        <For each={snapshot().primarySummary.lines}>
          {(line) => (
            <text fg={theme.text}>
              <span style={{ fg: theme.textMuted }}>› </span>
              {line}
            </text>
          )}
        </For>
      </box>

      <box flexDirection="row" flexWrap="wrap" gap={2} paddingLeft={1}>
        <For each={stats()}>
          {(stat) => (
            <text fg={theme.textMuted} onMouseUp={stat.go !== undefined ? () => go(stat.go!) : undefined}>
              <span style={{ fg: statColor(stat.label), bold: stat.label === "failed" && counts().failed > 0 }}>
                {stat.value}{" "}
              </span>
              {stat.label}
            </text>
          )}
        </For>
      </box>

      <Show when={resources() !== undefined}>
        {(() => {
          const r = resources()!
          return (
            <box flexDirection="column" gap={1} paddingLeft={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Budget & resources
              </text>
              <text fg={theme.textMuted}>
                tokens{" "}
                <span
                  style={{
                    fg: r.threshold === "hard" ? theme.error : r.threshold === "soft" ? theme.warning : theme.success,
                  }}
                >
                  {r.tokenBudget.used.toLocaleString()}
                  {r.tokenBudget.limit !== undefined ? ` / ${r.tokenBudget.limit.toLocaleString()}` : ""} ({Math.round(r.tokenBudget.ratio * 100)}%)
                </span>
                {" · "}model calls{" "}
                <span style={{ fg: theme.text }}>
                  {r.modelCalls.used}
                  {r.modelCalls.limit !== undefined ? ` / ${r.modelCalls.limit}` : ""} ({Math.round(r.modelCalls.ratio * 100)}%)
                </span>
                {" · "}LLM concurrent <span style={{ fg: theme.text }}>{r.llmCallsConcurrent}</span> / queued{" "}
                <span style={{ fg: theme.text }}>{r.llmCallsQueued}</span> · workspaces{" "}
                <span style={{ fg: theme.text }}>{r.activeWorkspaces}</span> · threshold{" "}
                <span
                  style={{ fg: r.threshold === "hard" ? theme.error : r.threshold === "soft" ? theme.warning : theme.success }}
                >
                  {r.threshold.toUpperCase()}
                </span>
              </text>
            </box>
          )
        })()}
      </Show>

      <Show when={snapshot().approvals.length > 0}>
        <box flexDirection="column" gap={1} paddingLeft={1} paddingTop={1}>
          <text fg={theme.warning} attributes={TextAttributes.BOLD}>
            Pending approvals ({snapshot().approvals.length})
          </text>
          <For each={snapshot().approvals.slice(0, 6)}>
            {(approval) => (
              <text fg={theme.textMuted} onMouseUp={() => go("approvals")}>
                <span style={{ fg: approval.severity === "HIGH" ? theme.error : theme.warning, bold: true }}>
                  [{approval.severity}]
                </span>{" "}
                <span style={{ fg: theme.text }}>{approval.summary}</span> — {approval.action} ·{" "}
                {fmtTime(snapshot().now, approval.time)}
              </text>
            )}
          </For>
          <text fg={theme.textMuted} onMouseUp={() => go("approvals")}>
            open approval inbox (tab 4)
          </text>
        </box>
      </Show>

      <Show when={snapshot().workers.length > 0}>
        <box flexDirection="column" gap={1} paddingLeft={1} paddingTop={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Workers
          </text>
          <For each={snapshot().workers}>
            {(worker) => (
              <text fg={theme.textMuted}>
                {worker.name} · <span style={{ fg: theme.text }}>{worker.active}/{worker.max}</span> active ·{" "}
                {Math.round(worker.ratio * 100)}% ·{" "}
                <span style={{ fg: worker.health === "healthy" ? theme.success : theme.error }}>{worker.health}</span>
              </text>
            )}
          </For>
        </box>
      </Show>

      <box paddingLeft={1} paddingTop={1}>
        <text fg={theme.textMuted}>
          audit {compact(snapshot().metrics.auditEvents)} events · active bound {snapshot().activeBound} ·{" "}
          {snapshot().paused ? "PAUSED" : "scheduling"}
        </text>
      </box>
    </box>
  )
}
