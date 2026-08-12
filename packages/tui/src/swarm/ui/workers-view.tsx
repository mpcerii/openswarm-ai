import { For, Show, createMemo, createSignal } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { useSwarm } from "../context"
import { useBindings } from "../../keymap"
import type { OverlayStore, OverlayActions } from "./overlay"
import type { SetStoreFunction } from "solid-js/store"

// ---------------------------------------------------------------------------
// Workers view: execution lanes with health, load and LLM concurrency. In the
// local kernel these are scheduler lanes projected from running agents; a
// distributed control plane swaps in the same shape from real cluster metrics.
// Keyboard: ↑/↓ move.
// ---------------------------------------------------------------------------

export function WorkersView(props: {
  store: OverlayStore
  setStore: SetStoreFunction<OverlayStore>
  actions: OverlayActions
  height: number
}) {
  const { theme } = useTheme()
  const swarm = useSwarm()
  const [selected, setSelected] = createSignal(0)

  const snapshot = () => swarm.snapshot!
  const workers = createMemo(() => snapshot().workers)
  const selectedWorker = createMemo(() => workers()[selected()])

  function move(direction: number) {
    if (workers().length === 0) return
    setSelected((selected() + direction + workers().length) % workers().length)
  }

  useBindings(() => ({
    enabled: () => props.store.tab === "workers",
    commands: [
      { name: "swarm.workers.prev", title: "Previous worker", category: "Swarm", run: () => move(-1) },
      { name: "swarm.workers.next", title: "Next worker", category: "Swarm", run: () => move(1) },
    ],
    bindings: [
      { key: "up", desc: "Previous worker", group: "Swarm", cmd: "swarm.workers.prev" },
      { key: "down", desc: "Next worker", group: "Swarm", cmd: "swarm.workers.next" },
    ],
  }))

  return (
    <box flexDirection="column" gap={1} minHeight={0} flexGrow={1}>
      <box paddingLeft={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Workers ({workers().length})
        </text>
      </box>
      <box flexGrow={1} minHeight={0}>
        <For each={workers()}>
          {(worker, index) => {
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
                <text flexGrow={1} fg={active ? theme.background : theme.text}>
                  {worker.name}
                </text>
                <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                  {worker.id}
                </text>
                <text flexShrink={0} fg={active ? theme.background : worker.health === "healthy" ? theme.success : theme.error}>
                  {worker.health}
                </text>
                <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                  {worker.active}/{worker.max}
                </text>
                <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                  {Math.round(worker.ratio * 100)}%
                </text>
                <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                  llm {worker.llmActive}
                </text>
              </box>
            )
          }}
        </For>
      </box>
      <Show when={selectedWorker() !== undefined}>
        <text fg={theme.textMuted}>
          {selectedWorker()!.name}: {selectedWorker()!.active} executing, {selectedWorker()!.max} capacity, {Math.round(selectedWorker()!.ratio * 100)}% utilized. Drain/offline are control-plane actions (not available on local lanes).
        </text>
      </Show>
    </box>
  )
}
