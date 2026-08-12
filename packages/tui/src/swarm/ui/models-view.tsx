import { For, Show, createMemo, createSignal } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { useSwarm } from "../context"
import { useBindings } from "../../keymap"
import type { OverlayStore, OverlayActions } from "./overlay"
import type { SetStoreFunction } from "solid-js/store"

// ---------------------------------------------------------------------------
// Models view: every authorized model with health, concurrency and queue.
// The human owns model policy — disable/enable stops scheduling on that model
// (never edits the allowlist; it toggles operational health). Keyboard: ↑/↓
// move, d disable, e enable.
// ---------------------------------------------------------------------------

function healthLabel(health: string, disabled: boolean): string {
  if (disabled && health === "unavailable") return "unavailable (not in configured providers)"
  if (disabled) return "disabled"
  return health
}

export function ModelsView(props: {
  store: OverlayStore
  setStore: SetStoreFunction<OverlayStore>
  actions: OverlayActions
  height: number
}) {
  const { theme } = useTheme()
  const swarm = useSwarm()
  const [selected, setSelected] = createSignal(0)

  const snapshot = () => swarm.snapshot!
  const models = createMemo(() => snapshot().models)
  const detail = createMemo(() => models()[selected()])

  function move(direction: number) {
    if (models().length === 0) return
    setSelected((selected() + direction + models().length) % models().length)
  }

  const healthFg = (m: { health: string; disabled: boolean }) => {
    if (m.disabled) return theme.error
    if (m.health !== "healthy") return theme.warning
    return theme.success
  }

  useBindings(() => ({
    enabled: () => props.store.tab === "models",
    commands: [
      { name: "swarm.models.prev", title: "Previous model", category: "Swarm", run: () => move(-1) },
      { name: "swarm.models.next", title: "Next model", category: "Swarm", run: () => move(1) },
      { name: "swarm.models.toggle", title: "Disable / enable model", category: "Swarm", run: () => {
        const m = detail()
        if (m !== undefined) props.actions.disableModel(m.model, !m.disabled)
      } },
    ],
    bindings: [
      { key: "up", desc: "Previous model", group: "Swarm", cmd: "swarm.models.prev" },
      { key: "down", desc: "Next model", group: "Swarm", cmd: "swarm.models.next" },
      { key: "d", desc: "Disable / enable model", group: "Swarm", cmd: "swarm.models.toggle" },
      { key: "e", desc: "Disable / enable model", group: "Swarm", cmd: "swarm.models.toggle" },
    ],
  }))

  return (
    <box flexDirection="column" gap={1} minHeight={0} flexGrow={1}>
      <box paddingLeft={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Models ({models().length}) — human-owned policy
        </text>
      </box>
      <text fg={theme.textMuted}>d/e toggle disabled (stops scheduling on the model, keeps the allowlist)</text>
      <box flexGrow={1} minHeight={0}>
        <For each={models()}>
          {(model, index) => {
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
                <text flexGrow={1} fg={active ? theme.background : theme.text} wrapMode="none" overflow="hidden">
                  {model.model}
                </text>
                <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                  {model.provider}
                </text>
                <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                  {model.authorized ? "allowed" : "denied"}
                </text>
                <text flexShrink={0} fg={active ? theme.background : healthFg(model)}>
                  {healthLabel(model.health, model.disabled)}
                </text>
                <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                  {model.active} active
                </text>
                <Show when={model.queued > 0}>
                  <text flexShrink={0} fg={active ? theme.background : theme.warning}>
                    {model.queued} queued
                  </text>
                </Show>
                <Show when={model.concurrencyLimit !== undefined}>
                  <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                    /{model.concurrencyLimit}
                  </text>
                </Show>
              </box>
            )
          }}
        </For>
      </box>
      <Show when={detail() !== undefined}>
        {(() => {
          const m = detail()!
          return (
            <text fg={theme.textMuted}>
              {m.model} · pools: {m.pools.length > 0 ? m.pools.join(", ") : "—"} · context {m.contextWindow !== undefined ? `${Math.round(m.contextWindow / 1000)}k` : "?"}
            </text>
          )
        })()}
      </Show>
    </box>
  )
}
