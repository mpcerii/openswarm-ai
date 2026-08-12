import { For, Show, createMemo, createSignal } from "solid-js"
import { TextAttributes, type InputRenderable } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { useSwarm } from "../context"
import { useBindings } from "../../keymap"
import { useTerminalDimensions } from "@opentui/solid"
import { visibleTree, pageForNode, distinctModels } from "../state/tree"
import { compact, inputCursor, SelectRow, stateColor } from "./common"
import type { OverlayStore, OverlayActions, SwarmTab } from "./overlay"
import type { SetStoreFunction } from "solid-js/store"

// ---------------------------------------------------------------------------
// Agents view: collapsible hierarchy tree (Primary → children with descendant
// counts; only expanded rows render) + an operational detail pane.
// Keyboard: ↑/↓ move, →/enter expand or select, ← collapse, / focus filter,
// x cancel, b cancel branch, m message, esc back to the list. Targeted input
// bindings take priority over tree navigation while a filter is focused, so
// navigation stays predictable without relying on color or mouse.
// ---------------------------------------------------------------------------

const STATE_FILTERS = ["all", "running", "queued", "waiting", "awaiting_approval", "failed", "completed", "cancelled"] as const

export function AgentsView(props: {
  store: OverlayStore
  setStore: SetStoreFunction<OverlayStore>
  actions: OverlayActions
  height: number
}) {
  const { theme } = useTheme()
  const swarm = useSwarm()
  const dimensions = useTerminalDimensions()
  const [filterEl, setFilterEl] = createSignal<InputRenderable | undefined>()
  const [composeEl, setComposeEl] = createSignal<InputRenderable | undefined>()
  const [composing, setComposing] = createSignal(false)
  const [composeValue, setComposeValue] = createSignal("")

  const snapshot = () => swarm.snapshot!
  const expandedSet = () => new Set(props.store.expanded)

  const tree = createMemo(() =>
    visibleTree(snapshot(), {
      expanded: expandedSet(),
      filter: props.store.filter,
      stateFilter: props.store.stateFilter as "all",
      modelFilter: props.store.modelFilter,
      page: props.store.page,
      pageSize: props.store.pageSize,
    }),
  )

  const selectedIndex = createMemo(() => {
    const id = props.store.selectedAgentID
    if (id === undefined) return -1
    return tree().nodes.findIndex((n) => n.id === id)
  })

  const modelOptions = createMemo(() => distinctModels(snapshot()))

  const wide = () => dimensions().width > 120
  const detailWidth = () => (wide() ? 46 : Math.max(20, dimensions().width - 8))

  function moveSelection(direction: number) {
    const nodes = tree().nodes
    if (nodes.length === 0) return
    const current = selectedIndex()
    const next = (current + direction + nodes.length) % nodes.length
    props.setStore("selectedAgentID", nodes[next]!.id)
  }

  function setPageFor(expanded: ReadonlySet<string>, agentID: string) {
    const page = pageForNode(
      snapshot(),
      { expanded, filter: props.store.filter, stateFilter: props.store.stateFilter as "all", modelFilter: props.store.modelFilter, page: 0, pageSize: props.store.pageSize },
      agentID,
    )
    props.setStore("page", page)
  }

  function toggleExpand(nodeId: string) {
    const target = tree().nodes.find((n) => n.id === nodeId)
    if (target === undefined || !target.hasChildren) return
    const expanded = new Set(props.store.expanded)
    if (expanded.has(target.id)) expanded.delete(target.id)
    else expanded.add(target.id)
    props.setStore("expanded", [...expanded])
    setPageFor(expanded, target.id)
  }

  function openNode() {
    const nodes = tree().nodes
    const selected = nodes[selectedIndex()]
    if (selected === undefined) return
    if (selected.hasChildren) {
      toggleExpand(selected.id)
      return
    }
    props.setStore("selectedAgentID", selected.id)
  }

  function collapseToParent() {
    const id = props.store.selectedAgentID
    if (id === undefined) return
    const expanded = new Set(props.store.expanded)
    if (expanded.has(id)) {
      expanded.delete(id)
      props.setStore("expanded", [...expanded])
      return
    }
    const index = snapshot().agentsByID.get(id)
    const parent = index !== undefined ? snapshot().agents[index]!.parent : undefined
    if (parent !== undefined) props.setStore("selectedAgentID", parent)
  }

  function startCompose() {
    setComposeValue("")
    setComposing(true)
    setTimeout(() => composeEl()?.focus(), 1)
  }

  function sendCompose(value: string) {
    if (props.store.selectedAgentID !== undefined && value.trim().length > 0) {
      props.actions.messageAgent(props.store.selectedAgentID, value)
    }
    setComposing(false)
  }

  useBindings(() => ({
    enabled: () => props.store.tab === "agents",
    commands: [
      { name: "swarm.agents.prev", title: "Previous agent", category: "Swarm", run: () => moveSelection(-1) },
      { name: "swarm.agents.next", title: "Next agent", category: "Swarm", run: () => moveSelection(1) },
      { name: "swarm.agents.collapse", title: "Collapse / parent", category: "Swarm", run: collapseToParent },
      { name: "swarm.agents.open", title: "Expand / select", category: "Swarm", run: openNode },
      { name: "swarm.agents.prev_page", title: "Previous page", category: "Swarm", run: () => props.setStore("page", Math.max(0, props.store.page - 1)) },
      { name: "swarm.agents.next_page", title: "Next page", category: "Swarm", run: () => props.setStore("page", Math.min(tree().pages - 1, props.store.page + 1)) },
      { name: "swarm.agents.filter", title: "Focus agent filter", category: "Swarm", run: () => setTimeout(() => filterEl()?.focus(), 1) },
      { name: "swarm.agents.cancel", title: "Cancel selected agent", category: "Swarm", run: () => {
        if (props.store.selectedAgentID !== undefined) props.actions.cancelAgent(props.store.selectedAgentID)
      } },
      { name: "swarm.agents.cancel_branch", title: "Cancel selected branch", category: "Swarm", run: () => {
        if (props.store.selectedAgentID !== undefined) props.actions.cancelBranch(props.store.selectedAgentID)
      } },
      { name: "swarm.agents.message", title: "Message selected agent", category: "Swarm", run: startCompose },
    ],
    bindings: [
      { key: "up", desc: "Previous agent", group: "Swarm", cmd: "swarm.agents.prev" },
      { key: "down", desc: "Next agent", group: "Swarm", cmd: "swarm.agents.next" },
      { key: "left", desc: "Collapse / parent", group: "Swarm", cmd: "swarm.agents.collapse" },
      { key: "right", desc: "Expand / select", group: "Swarm", cmd: "swarm.agents.open" },
      { key: "return", desc: "Expand / select", group: "Swarm", cmd: "swarm.agents.open" },
      { key: "pageup", desc: "Previous page", group: "Swarm", cmd: "swarm.agents.prev_page" },
      { key: "pagedown", desc: "Next page", group: "Swarm", cmd: "swarm.agents.next_page" },
      { key: "/", desc: "Filter agents", group: "Swarm", cmd: "swarm.agents.filter" },
      { key: "x", desc: "Cancel agent", group: "Swarm", cmd: "swarm.agents.cancel" },
      { key: "b", desc: "Cancel branch", group: "Swarm", cmd: "swarm.agents.cancel_branch" },
      { key: "m", desc: "Message agent", group: "Swarm", cmd: "swarm.agents.message" },
    ],
  }))

  // Filter input: typing filters live; escape blurs back to tree navigation.
  useBindings(() => ({
    target: () => filterEl(),
    enabled: () => props.store.tab === "agents",
    commands: [
      { name: "swarm.filter.clear", title: "Clear filter", category: "Swarm", run: () => {
        props.setStore("filter", "")
        props.setStore("page", 0)
        filterEl()?.blur()
      } },
    ],
    bindings: [{ key: "escape", desc: "Clear filter", group: "Swarm", cmd: "swarm.filter.clear" }],
  }))

  // Compose input: enter sends, escape cancels.
  useBindings(() => ({
    target: () => composeEl(),
    enabled: () => props.store.tab === "agents" && composing(),
    commands: [
      { name: "swarm.compose.cancel", title: "Cancel message", category: "Swarm", run: () => setComposing(false) },
    ],
    bindings: [
      { key: "escape", desc: "Cancel message", group: "Swarm", cmd: "swarm.compose.cancel" },
      { key: "return", desc: "Send message", group: "Swarm", cmd: () => sendCompose(composeValue()) },
    ],
  }))

  const detail = createMemo(() => {
    const id = props.store.selectedAgentID
    if (id === undefined) return undefined
    const index = snapshot().agentsByID.get(id)
    if (index === undefined) return undefined
    const agent = snapshot().agents[index]!
    const parent = agent.parent !== undefined ? snapshot().agents[snapshot().agentsByID.get(agent.parent)!] : undefined
    const approval = snapshot().approvals.find((a) => a.agentID === id)
    return {
      agent,
      parent,
      childCount: snapshot().childCounts.get(index) ?? 0,
      descendantCount: snapshot().descendantCounts.get(index) ?? 0,
      artifacts: snapshot().artifacts.filter((a) => a.agentID === id).length,
      tasks: snapshot().tasks.filter((t) => t.agentID === id).length,
      approval,
    }
  })

  return (
    <box flexDirection="row" gap={1} minHeight={0} flexGrow={1}>
      <box flexDirection="column" gap={1} flexGrow={1} minHeight={0}>
        <box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          <input
            ref={(r) => setFilterEl(r)}
            onInput={(value) => {
              props.setStore("filter", value)
              props.setStore("page", 0)
            }}
            value={props.store.filter}
            placeholder={`filter ${compact(snapshot().agents.length)} agents ( / to focus )`}
            placeholderColor={theme.textMuted}
            focusedTextColor={theme.textMuted}
            cursorColor={theme.primary}
            cursorStyle={inputCursor}
          />
          <For each={STATE_FILTERS}>
            {(state) => (
              <SelectRow
                active={props.store.stateFilter === state}
                onClick={() => {
                  props.setStore("stateFilter", state)
                  props.setStore("page", 0)
                }}
              >
                <text fg={props.store.stateFilter === state ? theme.background : theme.textMuted}>{state}</text>
              </SelectRow>
            )}
          </For>
          <Show when={modelOptions().length > 0}>
            <text fg={theme.textMuted}>model:</text>
            <For each={modelOptions()}>
              {(model) => (
                <SelectRow
                  active={props.store.modelFilter === model}
                  onClick={() => {
                    props.setStore("modelFilter", props.store.modelFilter === model ? "" : model)
                    props.setStore("page", 0)
                  }}
                >
                  <text fg={props.store.modelFilter === model ? theme.background : theme.textMuted}>{model}</text>
                </SelectRow>
              )}
            </For>
          </Show>
        </box>
        <box flexGrow={1} minHeight={0}>
          <For each={tree().nodes}>
            {(node) => {
              const active = node.id === props.store.selectedAgentID
              const indent = " ".repeat(Math.min(node.depth, 24))
              const marker = node.hasChildren ? (node.expanded ? "▾" : "▸") : " "
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active ? theme.primary : undefined}
                  onMouseUp={() => props.setStore("selectedAgentID", node.id)}
                >
                  <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                    {indent}
                    {marker}
                  </text>
                  <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                    {node.role ?? "agent"}
                  </text>
                  <text flexGrow={1} fg={active ? theme.background : theme.text} wrapMode="none" overflow="hidden">
                    {node.id}
                    <Show when={node.hasChildren}>
                      <span style={{ fg: active ? theme.background : theme.textMuted }}> [{node.descendantCount}]</span>
                    </Show>
                  </text>
                  <text flexShrink={0} fg={active ? theme.background : stateColor(theme, node.state)}>
                    {node.state}
                  </text>
                  <Show when={node.resolvedModel !== undefined}>
                    <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                      {node.resolvedModel}
                    </text>
                  </Show>
                </box>
              )
            }}
          </For>
          <Show when={tree().nodes.length === 0}>
            <box paddingLeft={1}>
              <text fg={theme.textMuted}>no agents match the current filter</text>
            </box>
          </Show>
        </box>
        <Show when={props.store.filter.length > 0}>
          <text fg={theme.textMuted}>
            {tree().total} match · page {props.store.page + 1}/{tree().pages} · esc clears
          </text>
        </Show>
        <Show when={tree().pages > 1 && props.store.filter.length === 0}>
          <text fg={theme.textMuted}>
            page {props.store.page + 1}/{tree().pages} · {tree().total} rows (pgup/pgdn)
          </text>
        </Show>
      </box>

      <Show when={detail() !== undefined}>
        <box width={detailWidth()} flexShrink={0} border={["left"]} borderColor={theme.border} paddingLeft={2} minHeight={0} flexDirection="column" gap={1}>
          {(() => {
            const d = detail()!
            const agent = d.agent
            return (
              <>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  {agent.id}
                </text>
                <text fg={theme.textMuted}>
                  state <span style={{ fg: stateColor(theme, agent.state), bold: agent.state === "awaiting_approval" }}>{agent.state}</span>
                  {" · "}role <span style={{ fg: theme.text }}>{agent.role ?? "—"}</span>
                  {" · "}depth <span style={{ fg: theme.text }}>{agent.depth}</span>
                </text>
                <Show when={d.parent !== undefined}>
                  <text fg={theme.textMuted}>
                    parent <span style={{ fg: theme.text }}>{d.parent!.id}</span>
                  </text>
                </Show>
                <text fg={theme.textMuted}>
                  children <span style={{ fg: theme.text }}>{d.childCount}</span>
                  {d.descendantCount > d.childCount ? <> · descendants <span style={{ fg: theme.text }}>{d.descendantCount}</span></> : null}
                </text>
                <text fg={theme.textMuted}>
                  model <span style={{ fg: theme.text }}>{agent.resolvedModel ?? agent.model ?? "—"}</span>
                </text>
                <text fg={theme.textMuted}>
                  tasks <span style={{ fg: theme.text }}>{d.tasks}</span> · artifacts <span style={{ fg: theme.text }}>{d.artifacts}</span>
                </text>
                <Show when={agent.workspacePath !== undefined}>
                  <text fg={theme.textMuted}>
                    workspace <span style={{ fg: theme.text }}>{agent.workspacePath}</span>
                  </text>
                </Show>
                <Show when={d.approval !== undefined}>
                  <text fg={theme.warning}>
                    waiting on approval <span style={{ fg: theme.warning, bold: true }}>{d.approval!.action}</span>: {d.approval!.summary}
                  </text>
                </Show>
                <Show when={agent.lastError !== undefined}>
                  <text fg={theme.error}>last error: {agent.lastError}</text>
                </Show>
                <Show when={composing()}>
                  <input
                    ref={(r) => setComposeEl(r)}
                    onInput={(value) => setComposeValue(value)}
                    onSubmit={(value) => {
                      if (typeof value === "string") sendCompose(value)
                    }}
                    placeholder="message… (enter sends, esc cancels)"
                    placeholderColor={theme.textMuted}
                    cursorColor={theme.primary}
                    cursorStyle={inputCursor}
                  />
                </Show>
                <Show when={!composing()}>
                  <box flexDirection="row" gap={1} flexWrap="wrap">
                    <text fg={theme.textMuted} onMouseUp={() => props.setStore("tab", "tasks" as SwarmTab)}>
                      <span style={{ fg: theme.text }}>t</span> tasks
                    </text>
                    <text fg={theme.textMuted} onMouseUp={() => {
                      props.setStore("selectedArtifactID", undefined)
                      props.setStore("tab", "artifacts" as SwarmTab)
                    }}>
                      <span style={{ fg: theme.text }}>a</span> artifacts
                    </text>
                    <text fg={theme.textMuted} onMouseUp={() => props.setStore("tab", "activity" as SwarmTab)}>
                      <span style={{ fg: theme.text }}>e</span> events
                    </text>
                    <text fg={theme.textMuted} onMouseUp={() => props.actions.cancelAgent(agent.id)}>
                      <span style={{ fg: theme.error }}>x</span> cancel
                    </text>
                    <text fg={theme.textMuted} onMouseUp={() => props.actions.cancelBranch(agent.id)}>
                      <span style={{ fg: theme.error }}>b</span> branch
                    </text>
                    <text fg={theme.textMuted} onMouseUp={startCompose}>
                      <span style={{ fg: theme.text }}>m</span> message
                    </text>
                  </box>
                </Show>
              </>
            )
          })()}
        </box>
      </Show>
    </box>
  )
}
