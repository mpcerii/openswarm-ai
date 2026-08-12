import { createMemo, createSignal } from "solid-js"
import { TextAttributes, type InputRenderable } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { useSwarm } from "../context"
import { useBindings } from "../../keymap"
import { inputCursor } from "./common"
import type { OverlayStore, OverlayActions } from "./overlay"
import type { SetStoreFunction } from "solid-js/store"
import { ServerSwarmBridge } from "../server-bridge"

// ---------------------------------------------------------------------------
// Provenance view (/why): renders the attribution chain for a changed file —
// mission → task → agent → artifact → reviews → approval → integration. The
// chain is fetched from the real server /swarm/why endpoint (stored
// operational facts only — never hidden chain-of-thought).
// ---------------------------------------------------------------------------

export function ProvenanceView(props: {
  store: OverlayStore
  setStore: SetStoreFunction<OverlayStore>
  actions: OverlayActions
  height: number
}) {
  const { theme } = useTheme()
  const swarm = useSwarm()
  const [fileEl, setFileEl] = createSignal<InputRenderable | undefined>()
  const [file, setFile] = createSignal(props.store.provenanceFile)
  const [chainText, setChainText] = createSignal<string>("")

  const chain = createMemo(() => {
    const value = file().trim()
    if (value.length === 0) return "type a file path, then press enter"
    const bridge = swarm.bridge
    if (bridge === undefined) return "swarm not ready"
    if (!(bridge instanceof ServerSwarmBridge)) return "/why is only available in the server-backed bridge"
    return chainText()
  })

  function submit(value: string) {
    setFile(value)
    props.setStore("provenanceFile", value)
    const bridge = swarm.bridge
    if (bridge instanceof ServerSwarmBridge && value.trim().length > 0) {
      setChainText("loading…")
      void bridge.provenance(value.trim()).then(setChainText).catch((e) => setChainText(`error: ${e instanceof Error ? e.message : String(e)}`))
    }
  }

  useBindings(() => ({
    target: () => fileEl(),
    enabled: () => props.store.tab === "why",
    commands: [{ name: "swarm.why.submit", title: "Render /why chain", category: "Swarm", run: () => submit(file()) }],
    bindings: [{ key: "return", desc: "Render /why chain", group: "Swarm", cmd: () => submit(file()) }],
  }))

  return (
    <box flexDirection="column" gap={1} minHeight={0} flexGrow={1}>
      <box paddingLeft={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          /why — attribution chain
        </text>
      </box>
      <box flexDirection="row" gap={1} alignItems="center">
        <input
          ref={(r) => setFileEl(r)}
          onInput={(value) => setFile(value)}
          onSubmit={(value) => {
            if (typeof value === "string") submit(value)
          }}
          value={file()}
          placeholder="file path, e.g. packages/llm/parser.ts"
          placeholderColor={theme.textMuted}
          cursorColor={theme.primary}
          cursorStyle={inputCursor}
        />
        <text fg={theme.textMuted}>enter to render</text>
      </box>
      <box paddingLeft={1} flexDirection="column" gap={1} minHeight={0} flexGrow={1}>
        <ForLines text={chain()} theme={theme} />
      </box>
      <text fg={theme.textMuted}>
        chain: mission → task → implementer → artifact → reviews → human approval → integration (from the durable audit log)
      </text>
    </box>
  )
}

import { For } from "solid-js"

function ForLines(props: { text: string; theme: ReturnType<typeof useTheme>["theme"] }) {
  const lines = createMemo(() => props.text.split("\n"))
  return (
    <For each={lines()}>
      {(line, index) => (
        <text fg={index() === 0 ? props.theme.text : props.theme.textMuted}>
          {line}
        </text>
      )}
    </For>
  )
}
