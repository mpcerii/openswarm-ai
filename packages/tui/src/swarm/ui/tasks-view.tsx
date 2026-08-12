import { For, Show, createMemo, createSignal } from "solid-js"
import { TextAttributes, type InputRenderable } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { useSwarm } from "../context"
import { useBindings } from "../../keymap"
import { compact, fmtTime, inputCursor, SelectRow, stateColor } from "./common"
import type { OverlayStore, OverlayActions } from "./overlay"
import type { SetStoreFunction } from "solid-js/store"

// ---------------------------------------------------------------------------
// Tasks view: first-class task list (id, title, state, agent, artifacts) with
// a detail pane. Keyboard: ↑/↓ move, enter select, / filter, p/u prev/next
// page. Filtering uses the task list length bound; rendering is paginated.
// ---------------------------------------------------------------------------

const TASK_FILTERS = ["all", "pending", "in_progress", "blocked", "completed", "failed", "cancelled"] as const

export function TasksView(props: {
  store: OverlayStore
  setStore: SetStoreFunction<OverlayStore>
  actions: OverlayActions
  height: number
}) {
  const { theme } = useTheme()
  const swarm = useSwarm()
  const [filterEl, setFilterEl] = createSignal<InputRenderable | undefined>()
  const [filter, setFilter] = createSignal("")
  const [stateFilter, setStateFilter] = createSignal<(typeof TASK_FILTERS)[number]>("all")
  const [page, setPage] = createSignal(0)
  const [selected, setSelected] = createSignal<string | undefined>(props.store.selectedTaskID)

  const snapshot = () => swarm.snapshot!

  const pageSize = 24

  const all = createMemo(() => {
    const needle = filter().trim().toLowerCase()
    return snapshot().tasks.filter((t) => {
      if (stateFilter() !== "all" && t.state !== stateFilter()) return false
      if (needle.length === 0) return true
      return `${t.id} ${t.title} ${t.agentID}`.toLowerCase().includes(needle)
    }).sort((a, b) => b.updated - a.updated)
  })

  const pages = createMemo(() => Math.max(1, Math.ceil(all().length / pageSize)))
  const rows = createMemo(() => all().slice(page() * pageSize, (page() + 1) * pageSize))
  const selectedIndex = createMemo(() => rows().findIndex((t) => t.id === selected()))

  function move(direction: number) {
    const list = rows()
    if (list.length === 0) return
    const next = (selectedIndex() + direction + list.length) % list.length
    setSelected(list[next]!.id)
    props.setStore("selectedTaskID", list[next]!.id)
  }

  const detail = createMemo(() => {
    const id = selected()
    if (id === undefined) return undefined
    const task = snapshot().tasks.find((t) => t.id === id)
    if (task === undefined) return undefined
    const agent = snapshot().agents[snapshot().agentsByID.get(task.agentID)!]
    const artifacts = snapshot().artifacts.filter((a) => a.taskID === id)
    const children = snapshot().tasks.filter((t) => t.parentID === id)
    return { task, agent, artifacts, children }
  })

  useBindings(() => ({
    enabled: () => props.store.tab === "tasks",
    commands: [
      { name: "swarm.tasks.prev", title: "Previous task", category: "Swarm", run: () => move(-1) },
      { name: "swarm.tasks.next", title: "Next task", category: "Swarm", run: () => move(1) },
      { name: "swarm.tasks.prev_page", title: "Previous page", category: "Swarm", run: () => setPage(Math.max(0, page() - 1)) },
      { name: "swarm.tasks.next_page", title: "Next page", category: "Swarm", run: () => setPage(Math.min(pages() - 1, page() + 1)) },
      { name: "swarm.tasks.filter", title: "Focus task filter", category: "Swarm", run: () => setTimeout(() => filterEl()?.focus(), 1) },
    ],
    bindings: [
      { key: "up", desc: "Previous task", group: "Swarm", cmd: "swarm.tasks.prev" },
      { key: "down", desc: "Next task", group: "Swarm", cmd: "swarm.tasks.next" },
      { key: "pageup", desc: "Previous page", group: "Swarm", cmd: "swarm.tasks.prev_page" },
      { key: "pagedown", desc: "Next page", group: "Swarm", cmd: "swarm.tasks.next_page" },
      { key: "/", desc: "Filter tasks", group: "Swarm", cmd: "swarm.tasks.filter" },
    ],
  }))

  useBindings(() => ({
    target: () => filterEl(),
    enabled: () => props.store.tab === "tasks",
    commands: [{ name: "swarm.tasks.filter_clear", title: "Clear task filter", category: "Swarm", run: () => { setFilter(""); filterEl()?.blur() } }],
    bindings: [{ key: "escape", desc: "Clear task filter", group: "Swarm", cmd: "swarm.tasks.filter_clear" }],
  }))

  return (
    <box flexDirection="row" gap={1} minHeight={0} flexGrow={1}>
      <box flexDirection="column" gap={1} flexGrow={1} minHeight={0}>
        <box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          <input
            ref={(r) => setFilterEl(r)}
            onInput={(value) => { setFilter(value); setPage(0) }}
            value={filter()}
            placeholder={`filter ${compact(snapshot().tasks.length)} tasks`}
            placeholderColor={theme.textMuted}
            cursorColor={theme.primary}
            cursorStyle={inputCursor}
          />
          <For each={TASK_FILTERS}>
            {(state) => (
              <SelectRow
                active={stateFilter() === state}
                onClick={() => {
                  setStateFilter(state)
                  setPage(0)
                }}
              >
                <text fg={stateFilter() === state ? theme.background : theme.textMuted}>{state}</text>
              </SelectRow>
            )}
          </For>
        </box>
        <box flexGrow={1} minHeight={0}>
          <For each={rows()}>
            {(task) => {
              const active = task.id === selected()
              const artifacts = snapshot().artifacts.filter((a) => a.taskID === task.id).length
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active ? theme.primary : undefined}
                  onMouseUp={() => { setSelected(task.id); props.setStore("selectedTaskID", task.id) }}
                >
                  <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                    {task.state === "completed" ? "✓" : task.state === "failed" || task.state === "blocked" ? "!" : "·"}
                  </text>
                  <text flexGrow={1} fg={active ? theme.background : theme.text} wrapMode="none" overflow="hidden">
                    {task.id} {task.title}
                  </text>
                  <text flexShrink={0} fg={active ? theme.background : stateColor(theme, task.state)}>
                    {task.state}
                  </text>
                  <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                    {task.agentID}
                  </text>
                  <Show when={artifacts > 0}>
                    <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                      {artifacts} artifacts
                    </text>
                  </Show>
                </box>
              )
            }}
          </For>
          <Show when={rows().length === 0}>
            <box paddingLeft={1}>
              <text fg={theme.textMuted}>no tasks match</text>
            </box>
          </Show>
        </box>
        <Show when={pages() > 1}>
          <text fg={theme.textMuted}>page {page() + 1}/{pages()} · {all().length} tasks</text>
        </Show>
      </box>

      <Show when={detail() !== undefined}>
        <box width={52} flexShrink={0} border={["left"]} borderColor={theme.border} paddingLeft={2} flexDirection="column" gap={1}>
          {(() => {
            const d = detail()!
            return (
              <>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  {d.task.id}
                </text>
                <text fg={theme.text}>{d.task.title}</text>
                <text fg={theme.textMuted}>
                  state <span style={{ fg: stateColor(theme, d.task.state) }}>{d.task.state}</span> · updated {fmtTime(snapshot().now, d.task.updated)}
                </text>
                <Show when={d.agent !== undefined}>
                  <text fg={theme.textMuted}>
                    agent <span style={{ fg: theme.text }}>{d.agent!.id}</span> ({d.agent!.role ?? "—"})
                  </text>
                </Show>
                <Show when={d.children.length > 0}>
                  <text fg={theme.textMuted}>
                    depends on {d.children.length} sub-task{d.children.length > 1 ? "s" : ""}: {d.children.map((c) => (c.state === "completed" ? "✓ " : "") + c.id).join(", ")}
                  </text>
                </Show>
                <Show when={d.artifacts.length > 0}>
                  <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
                    artifacts ({d.artifacts.length})
                  </text>
                  <For each={d.artifacts}>
                    {(artifact) => (
                      <text fg={theme.textMuted}>
                        {artifact.kind} {artifact.id} · {artifact.state} · {artifact.changedFiles.length} file(s)
                      </text>
                    )}
                  </For>
                </Show>
              </>
            )
          })()}
        </box>
      </Show>
    </box>
  )
}
