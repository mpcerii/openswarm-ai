import { For, Show, createMemo, createSignal } from "solid-js"
import { TextAttributes, type InputRenderable } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { useSwarm } from "../context"
import { useBindings } from "../../keymap"
import { fmtTime, inputCursor } from "./common"
import type { OverlayStore, OverlayActions } from "./overlay"
import type { SetStoreFunction } from "solid-js/store"

// ---------------------------------------------------------------------------
// Artifacts view: patches/artifacts produced by the swarm (the integration
// candidates) with per-patch detail: changed files, tests + results, reviews,
// reason, diff preview. Keyboard: ↑/↓ move, / filter, pgup/pgdn pages.
// ---------------------------------------------------------------------------

export function ArtifactsView(props: {
  store: OverlayStore
  setStore: SetStoreFunction<OverlayStore>
  actions: OverlayActions
  height: number
}) {
  const { theme } = useTheme()
  const swarm = useSwarm()
  const [filterEl, setFilterEl] = createSignal<InputRenderable | undefined>()
  const [filter, setFilter] = createSignal("")
  const [page, setPage] = createSignal(0)
  const [selected, setSelected] = createSignal<string | undefined>(props.store.selectedArtifactID)
  const pageSize = 24

  const snapshot = () => swarm.snapshot!
  const all = createMemo(() => {
    const needle = filter().trim().toLowerCase()
    return snapshot().artifacts.filter((a) => {
      if (needle.length === 0) return true
      return `${a.id} ${a.summary ?? ""} ${a.reason} ${a.changedFiles.join(" ")}`.toLowerCase().includes(needle)
    }).sort((a, b) => b.time - a.time)
  })
  const pages = createMemo(() => Math.max(1, Math.ceil(all().length / pageSize)))
  const rows = createMemo(() => all().slice(page() * pageSize, (page() + 1) * pageSize))
  const selectedIndex = createMemo(() => rows().findIndex((a) => a.id === selected()))
  const detail = createMemo(() => all().find((a) => a.id === selected()))

  function move(direction: number) {
    if (rows().length === 0) return
    const next = (selectedIndex() + direction + rows().length) % rows().length
    setSelected(rows()[next]!.id)
    props.setStore("selectedArtifactID", rows()[next]!.id)
  }

  useBindings(() => ({
    enabled: () => props.store.tab === "artifacts",
    commands: [
      { name: "swarm.artifacts.prev", title: "Previous artifact", category: "Swarm", run: () => move(-1) },
      { name: "swarm.artifacts.next", title: "Next artifact", category: "Swarm", run: () => move(1) },
      { name: "swarm.artifacts.prev_page", title: "Previous page", category: "Swarm", run: () => setPage(Math.max(0, page() - 1)) },
      { name: "swarm.artifacts.next_page", title: "Next page", category: "Swarm", run: () => setPage(Math.min(pages() - 1, page() + 1)) },
      { name: "swarm.artifacts.filter", title: "Focus artifact filter", category: "Swarm", run: () => setTimeout(() => filterEl()?.focus(), 1) },
    ],
    bindings: [
      { key: "up", desc: "Previous artifact", group: "Swarm", cmd: "swarm.artifacts.prev" },
      { key: "down", desc: "Next artifact", group: "Swarm", cmd: "swarm.artifacts.next" },
      { key: "pageup", desc: "Previous page", group: "Swarm", cmd: "swarm.artifacts.prev_page" },
      { key: "pagedown", desc: "Next page", group: "Swarm", cmd: "swarm.artifacts.next_page" },
      { key: "/", desc: "Filter artifacts", group: "Swarm", cmd: "swarm.artifacts.filter" },
    ],
  }))

  useBindings(() => ({
    target: () => filterEl(),
    enabled: () => props.store.tab === "artifacts",
    commands: [{ name: "swarm.artifacts.filter_clear", title: "Clear artifact filter", category: "Swarm", run: () => { setFilter(""); filterEl()?.blur() } }],
    bindings: [{ key: "escape", desc: "Clear artifact filter", group: "Swarm", cmd: "swarm.artifacts.filter_clear" }],
  }))

  return (
    <box flexDirection="row" gap={1} minHeight={0} flexGrow={1}>
      <box flexDirection="column" gap={1} flexGrow={1} minHeight={0}>
        <box flexDirection="row" gap={1} alignItems="center">
          <input
            ref={(r) => setFilterEl(r)}
            onInput={(value) => { setFilter(value); setPage(0) }}
            value={filter()}
            placeholder="filter artifacts ( / )"
            placeholderColor={theme.textMuted}
            cursorColor={theme.primary}
            cursorStyle={inputCursor}
          />
          <text fg={theme.textMuted}>{all().length} artifacts</text>
        </box>
        <box flexGrow={1} minHeight={0}>
          <For each={rows()}>
            {(artifact) => {
              const active = artifact.id === selected()
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active ? theme.primary : undefined}
                  onMouseUp={() => { setSelected(artifact.id); props.setStore("selectedArtifactID", artifact.id) }}
                >
                  <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                    {artifact.state === "integrated" ? "✓" : artifact.state === "rejected" ? "✗" : artifact.state === "approved" ? "★" : "·"}
                  </text>
                  <text flexGrow={1} fg={active ? theme.background : theme.text} wrapMode="none" overflow="hidden">
                    {artifact.id} {artifact.summary ?? artifact.reason}
                  </text>
                  <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                    {artifact.kind}
                  </text>
                  <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                    {artifact.state}
                  </text>
                  <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                    {artifact.changedFiles.length}f
                  </text>
                  <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                    {fmtTime(snapshot().now, artifact.time)}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
      </box>

      <Show when={detail() !== undefined}>
        <box width={64} flexShrink={0} border={["left"]} borderColor={theme.border} paddingLeft={2} minHeight={0} flexDirection="column" gap={1}>
          {(() => {
            const a = detail()!
            const agent = snapshot().agents[snapshot().agentsByID.get(a.agentID)!]
            return (
              <>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  {a.id} · {a.state}
                </text>
                <text fg={theme.textMuted}>
                  kind <span style={{ fg: theme.text }}>{a.kind}</span> · ref <span style={{ fg: theme.text }}>{a.ref}</span> · base <span style={{ fg: theme.text }}>{a.baseCommit}</span>
                </text>
                <text fg={theme.textMuted}>
                  agent <span style={{ fg: theme.text }}>{a.agentID}</span> ({agent?.role ?? "—"})
                </text>
                <text fg={theme.textMuted}>reason: {a.reason}</text>
                <Show when={a.changedFiles.length > 0}>
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>
                    files ({a.changedFiles.length})
                  </text>
                  <For each={a.changedFiles}>
                    {(file) => (
                      <text fg={theme.textMuted}>
                        <span style={{ fg: theme.success }}>+</span>/<span style={{ fg: theme.error }}>−</span> {file}
                      </text>
                    )}
                  </For>
                </Show>
                <Show when={a.testsExecuted.length > 0}>
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>
                    tests ({a.testsExecuted.length})
                  </text>
                  <For each={a.testsExecuted.map((t, i) => ({ t, r: a.testResults[i] ?? "skipped" }))}>
                    {({ t, r }) => (
                      <text fg={theme.textMuted}>
                        <span style={{ fg: r === "pass" ? theme.success : r === "fail" ? theme.error : theme.textMuted }}>{r === "pass" ? "✓" : r === "fail" ? "✗" : "–"} {r}</span> {t}
                      </text>
                    )}
                  </For>
                </Show>
                <Show when={a.reviews.length > 0}>
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>
                    reviews ({a.reviews.length})
                  </text>
                  <For each={a.reviews}>
                    {(review) => (
                      <text fg={theme.textMuted}>
                        {review.verdict} · {review.objective} · {review.reviewerAgentID} · conf {review.confidence}
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
