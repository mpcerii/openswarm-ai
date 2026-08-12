import { For, Show, createMemo, createSignal } from "solid-js"
import { TextAttributes, type InputRenderable } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { useSwarm } from "../context"
import { useBindings } from "../../keymap"
import { inputCursor } from "./common"
import type { OverlayStore, OverlayActions } from "./overlay"
import type { SetStoreFunction } from "solid-js/store"

// ---------------------------------------------------------------------------
// Budget view: mission budget + resource governance. The human can raise or
// lower limits (clearing a hard stop) and change the active bound. Keyboard:
// ↑/↓ select a row, enter edit, e edit, esc leave edit.
// ---------------------------------------------------------------------------

export function BudgetView(props: {
  store: OverlayStore
  setStore: SetStoreFunction<OverlayStore>
  actions: OverlayActions
  height: number
}) {
  const { theme } = useTheme()
  const swarm = useSwarm()
  const [editEl, setEditEl] = createSignal<InputRenderable | undefined>()
  const [editing, setEditing] = createSignal<string | undefined>()
  const [editValue, setEditValue] = createSignal("")

  const snapshot = () => swarm.snapshot!
  const resource = () => snapshot().resources[0]
  const mission = () => snapshot().missions[0]

  const rows = createMemo(() => {
    const r = resource()
    if (r === undefined) return []
    return [
      { id: "population", label: "population", used: r.population, limit: r.maxAgents },
      { id: "active", label: "active agents", used: r.activeAgents, limit: undefined },
      { id: "workspaces", label: "coding workspaces", used: r.activeWorkspaces, limit: undefined },
      { id: "llm-concurrent", label: "LLM concurrent", used: r.llmCallsConcurrent, limit: undefined },
      { id: "llm-queued", label: "LLM queued", used: r.llmCallsQueued, limit: undefined },
      { id: "tokens", label: "tokens", used: r.tokenBudget.used, limit: r.tokenBudget.limit },
      { id: "model-calls", label: "model calls", used: r.modelCalls.used, limit: r.modelCalls.limit },
    ] as const
  })

  function bar(used: number, limit: number | undefined): string {
    const width = 24
    if (limit === undefined || limit <= 0) return "—"
    const ratio = Math.min(1, used / limit)
    const filled = Math.round(ratio * width)
    return "█".repeat(filled) + "░".repeat(width - filled)
  }

  function editRow(id: string) {
    const row = rows().find((r) => r.id === id)
    if (row === undefined) return
    setEditing(id)
    setEditValue(row.limit !== undefined ? String(row.limit) : "")
    setTimeout(() => editEl()?.focus(), 1)
  }

  function submitEdit() {
    const id = editing()
    const value = Number.parseInt(editValue(), 10)
    if (id === undefined || !Number.isFinite(value)) {
      setEditing(undefined)
      return
    }
    if (id === "tokens") mission() !== undefined && props.actions.setMissionLimits(mission()!.id, { max_tokens: value })
    if (id === "model-calls") mission() !== undefined && props.actions.setMissionLimits(mission()!.id, { max_model_calls: value })
    if (id === "active") props.actions.setActiveBound(value)
    if (id === "population") mission() !== undefined && props.actions.setMissionLimits(mission()!.id, {})
    setEditing(undefined)
  }

  useBindings(() => ({
    enabled: () => props.store.tab === "budget" && editing() === undefined,
    commands: [
      { name: "swarm.budget.edit_tokens", title: "Edit token limit", category: "Swarm", run: () => editRow("tokens") },
      { name: "swarm.budget.edit_calls", title: "Edit model call limit", category: "Swarm", run: () => editRow("model-calls") },
      { name: "swarm.budget.edit_active", title: "Edit active bound", category: "Swarm", run: () => editRow("active") },
    ],
    bindings: [
      { key: "e", desc: "Edit selected limit", group: "Swarm", cmd: () => {
        const target = selectedRow()
        if (target !== undefined) editRow(target.id)
      } },
    ],
  }))

  const [selected, setSelected] = createSignal(0)
  const selectedRow = () => rows()[selected()]

  useBindings(() => ({
    enabled: () => props.store.tab === "budget" && editing() === undefined,
    commands: [
      { name: "swarm.budget.prev", title: "Previous row", category: "Swarm", run: () => rows().length > 0 && setSelected((selected() - 1 + rows().length) % rows().length) },
      { name: "swarm.budget.next", title: "Next row", category: "Swarm", run: () => rows().length > 0 && setSelected((selected() + 1) % rows().length) },
    ],
    bindings: [
      { key: "up", desc: "Previous row", group: "Swarm", cmd: "swarm.budget.prev" },
      { key: "down", desc: "Next row", group: "Swarm", cmd: "swarm.budget.next" },
    ],
  }))

  useBindings(() => ({
    target: () => editEl(),
    enabled: () => props.store.tab === "budget" && editing() !== undefined,
    commands: [{ name: "swarm.budget.edit_cancel", title: "Cancel edit", category: "Swarm", run: () => setEditing(undefined) }],
    bindings: [
      { key: "escape", desc: "Cancel edit", group: "Swarm", cmd: "swarm.budget.edit_cancel" },
      { key: "return", desc: "Apply edit", group: "Swarm", cmd: submitEdit },
    ],
  }))

  return (
    <box flexDirection="column" gap={1} minHeight={0} flexGrow={1}>
      <Show when={mission() !== undefined}>
        <box paddingLeft={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Mission budget — {mission()!.title}
          </text>
        </box>
      </Show>
      <Show when={resource() !== undefined}>
        <text fg={theme.textMuted}>
          threshold{" "}
          <span style={{ fg: resource()!.threshold === "hard" ? theme.error : resource()!.threshold === "soft" ? theme.warning : theme.success, bold: resource()!.threshold !== "ok" }}>
            {resource()!.threshold.toUpperCase()}
          </span>
          {" "}· pending approvals <span style={{ fg: theme.warning }}>{resource()!.pendingApprovals}</span> · active bound <span style={{ fg: theme.text }}>{snapshot().activeBound}</span>
        </text>
      </Show>
      <Show when={resource() === undefined}>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>no mission budget seeded</text>
        </box>
      </Show>
      <box flexGrow={1} minHeight={0}>
        <For each={rows()}>
          {(row, index) => {
            const active = index() === selected()
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={active ? theme.primary : undefined}
                onMouseUp={() => setSelected(index())}
              >
                <text flexShrink={0} width={16} fg={active ? theme.background : theme.textMuted}>
                  {row.label}
                </text>
                <text fg={active ? theme.background : theme.text}>
                  {bar(row.used, row.limit)}
                </text>
                <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                  {row.used.toLocaleString()}{row.limit !== undefined ? ` / ${row.limit.toLocaleString()}` : ""}
                </text>
                <Show when={row.limit !== undefined}>
                  <text flexShrink={0} fg={active ? theme.background : row.limit !== undefined && row.limit > 0 && row.used / row.limit > 0.8 ? theme.warning : theme.textMuted}>
                    {row.limit !== undefined && row.limit > 0 ? `${Math.round((row.used / row.limit) * 100)}%` : ""}
                  </text>
                </Show>
              </box>
            )
          }}
        </For>
      </box>
      <Show when={editing() !== undefined}>
        <input
          ref={(r) => setEditEl(r)}
          onInput={(value) => setEditValue(value)}
          onSubmit={() => submitEdit()}
          value={editValue()}
          placeholder="new limit"
          placeholderColor={theme.textMuted}
          cursorColor={theme.primary}
          cursorStyle={inputCursor}
        />
      </Show>
      <Show when={editing() === undefined && resource() !== undefined}>
        <text fg={theme.textMuted}>
          ↑/↓ select · e edit limit (tokens/calls/active) · esc back
        </text>
      </Show>
    </box>
  )
}
