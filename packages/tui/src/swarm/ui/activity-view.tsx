import { For, Show, createMemo, createSignal } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { useSwarm } from "../context"
import { useBindings } from "../../keymap"
import { fmtTime, severityColor, severityMarker } from "./common"
import type { OverlayStore, OverlayActions } from "./overlay"
import type { SetStoreFunction } from "solid-js/store"

// ---------------------------------------------------------------------------
// Activity view: the curated, human-relevant event stream (findings, patches,
// reviews, approvals, budgets, worker/model health) — NOT raw internal model
// chatter. Severity is carried by a textual marker as well as color so the
// stream stays readable in limited-color terminals. Keyboard: ↑/↓, pgup/pgdn.
// ---------------------------------------------------------------------------

export function ActivityView(props: {
  store: OverlayStore
  setStore: SetStoreFunction<OverlayStore>
  actions: OverlayActions
  height: number
}) {
  const { theme } = useTheme()
  const swarm = useSwarm()
  const [selected, setSelected] = createSignal(0)
  const pageSize = 40

  const snapshot = () => swarm.snapshot!
  const events = createMemo(() => snapshot().activity)
  const pages = createMemo(() => Math.max(1, Math.ceil(events().length / pageSize)))
  const [page, setPage] = createSignal(0)
  const rows = createMemo(() => events().slice(page() * pageSize, (page() + 1) * pageSize))
  const selectedEvent = createMemo(() => rows()[selected()])

  function move(direction: number) {
    if (rows().length === 0) return
    const next = (selected() + direction + rows().length) % rows().length
    setSelected(next)
  }

  useBindings(() => ({
    enabled: () => props.store.tab === "activity",
    commands: [
      { name: "swarm.activity.prev", title: "Previous event", category: "Swarm", run: () => move(-1) },
      { name: "swarm.activity.next", title: "Next event", category: "Swarm", run: () => move(1) },
      { name: "swarm.activity.prev_page", title: "Previous page", category: "Swarm", run: () => setPage(Math.max(0, page() - 1)) },
      { name: "swarm.activity.next_page", title: "Next page", category: "Swarm", run: () => setPage(Math.min(pages() - 1, page() + 1)) },
    ],
    bindings: [
      { key: "up", desc: "Previous event", group: "Swarm", cmd: "swarm.activity.prev" },
      { key: "down", desc: "Next event", group: "Swarm", cmd: "swarm.activity.next" },
      { key: "pageup", desc: "Previous page", group: "Swarm", cmd: "swarm.activity.prev_page" },
      { key: "pagedown", desc: "Next page", group: "Swarm", cmd: "swarm.activity.next_page" },
    ],
  }))

  return (
    <box flexDirection="column" gap={1} minHeight={0} flexGrow={1}>
      <box paddingLeft={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Activity ({events().length} human-relevant events)
        </text>
      </box>
      <box flexGrow={1} minHeight={0}>
        <For each={rows()}>
          {(event, index) => {
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
                <text flexShrink={0} fg={active ? theme.background : severityColor(theme, event.severity)}>
                  [{severityMarker(event.severity)}]
                </text>
                <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                  {fmtTime(snapshot().now, event.time)}
                </text>
                <text flexGrow={1} fg={active ? theme.background : theme.text} wrapMode="none" overflow="hidden">
                  {event.title}
                </text>
                <Show when={event.agentID !== undefined}>
                  <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                    {event.agentID}
                  </text>
                </Show>
              </box>
            )
          }}
        </For>
      </box>
      <Show when={selectedEvent() !== undefined && selectedEvent()!.detail !== undefined}>
        <text fg={theme.textMuted}>
          <span style={{ fg: severityColor(theme, selectedEvent()!.severity) }}>[{severityMarker(selectedEvent()!.severity)}]</span> {selectedEvent()!.type} — {selectedEvent()!.detail}
        </text>
      </Show>
      <Show when={pages() > 1}>
        <text fg={theme.textMuted}>page {page() + 1}/{pages()}</text>
      </Show>
    </box>
  )
}
