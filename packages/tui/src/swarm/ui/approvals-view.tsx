import { For, Show, createMemo, createSignal } from "solid-js"
import { TextAttributes, type InputRenderable } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { useSwarm } from "../context"
import { useBindings } from "../../keymap"
import { sortApprovals, integrationReview } from "../state/approvals"
import { fmtTime, inputCursor, severityColor, severityMarker, stateColor } from "./common"
import type { OverlayStore, OverlayActions } from "./overlay"
import type { SetStoreFunction } from "solid-js/store"

// ---------------------------------------------------------------------------
// Approvals view: severity-sorted pending-approval inbox + a detail pane with
// risk level, affected resources, and human actions. Integration approvals
// expand into the consolidated review (files, patches, tests, reviews) so a
// large change is judged in one place before signing off.
// ---------------------------------------------------------------------------

export function ApprovalsView(props: {
  store: OverlayStore
  setStore: SetStoreFunction<OverlayStore>
  actions: OverlayActions
  height: number
}) {
  const { theme } = useTheme()
  const swarm = useSwarm()
  const [modifyEl, setModifyEl] = createSignal<InputRenderable | undefined>()
  const [modifyTarget, setModifyTarget] = createSignal<string | undefined>()
  const [modifyValue, setModifyValue] = createSignal("")
  const [selected, setSelected] = createSignal<string | undefined>(props.store.selectedApprovalID)
  const [showReview, setShowReview] = createSignal(false)

  const snapshot = () => swarm.snapshot!
  const list = createMemo(() => sortApprovals(snapshot().approvals))
  const selectedIndex = createMemo(() => list().findIndex((a) => a.id === selected()))

  const detail = createMemo(() => list().find((a) => a.id === selected()))
  const requestingAgent = createMemo(() => {
    const approval = detail()
    if (approval === undefined) return undefined
    return snapshot().agents[snapshot().agentsByID.get(approval.agentID)!]
  })
  const mission = createMemo(() => {
    const approval = detail()
    if (approval === undefined) return undefined
    return snapshot().missions.find((m) => m.id === approval.mission)
  })
  const primary = createMemo(() => snapshot().agents.find((a) => a.depth === 0))
  const review = createMemo(() => {
    if (!showReview()) return undefined
    const approval = detail()
    if (approval === undefined || approval.action !== "integration") return undefined
    if (mission() === undefined) return undefined
    return integrationReview(snapshot().artifacts, { id: mission()!.id, title: mission()!.title }, snapshot().now)
  })

  function move(direction: number) {
    if (list().length === 0) return
    const next = (selectedIndex() + direction + list().length) % list().length
    setSelected(list()[next]!.id)
    props.setStore("selectedApprovalID", list()[next]!.id)
  }

  function approveOnce() {
    const id = selected()
    if (id !== undefined) props.actions.approveOnce(id)
    setSelected(undefined)
  }

  function approveScope() {
    const id = selected()
    if (id !== undefined) props.actions.approveScope(id)
    setSelected(undefined)
  }

  function reject() {
    const id = selected()
    if (id !== undefined) props.actions.reject(id)
    setSelected(undefined)
  }

  function askPrimary() {
    const approval = detail()
    const primaryAgent = primary()
    if (approval === undefined || primaryAgent === undefined) return
    props.actions.messageAgent(primaryAgent.id, `Please review and summarize the pending ${approval.action} approval "${approval.summary}" (agent ${approval.agentID}) so I can decide.`)
  }

  function startModify() {
    const approval = detail()
    if (approval === undefined) return
    setModifyTarget(approval.id)
    setModifyValue(approval.action === "budget_increase" ? "max_model_calls:1000,max_tokens:500000" : approval.resource ?? "")
    setTimeout(() => modifyEl()?.focus(), 1)
  }

  function submitModify(value: string) {
    const approval = detail()
    if (approval === undefined || modifyTarget() !== approval.id) return
    if (approval.action === "budget_increase") {
      const limits: Record<string, number> = {}
      for (const part of value.split(",")) {
        const [key, raw] = part.trim().split(":")
        if (key === undefined || raw === undefined) continue
        const n = Number.parseInt(raw, 10)
        if (Number.isFinite(n)) limits[key] = n
      }
      props.actions.resolveBudget(approval.id, limits as { max_model_calls?: number; max_tokens?: number })
    } else {
      props.actions.approveScope(approval.id, { resourcePatterns: value.split(",").map((s) => s.trim()).filter(Boolean) })
    }
    setModifyTarget(undefined)
    setSelected(undefined)
  }

  useBindings(() => ({
    enabled: () => props.store.tab === "approvals",
    commands: [
      { name: "swarm.approvals.prev", title: "Previous approval", category: "Swarm", run: () => move(-1) },
      { name: "swarm.approvals.next", title: "Next approval", category: "Swarm", run: () => move(1) },
      { name: "swarm.approvals.approve_once", title: "Approve once", category: "Swarm", run: approveOnce },
      { name: "swarm.approvals.approve_scope", title: "Approve scope", category: "Swarm", run: approveScope },
      { name: "swarm.approvals.reject", title: "Reject", category: "Swarm", run: reject },
      { name: "swarm.approvals.modify", title: "Modify scope", category: "Swarm", run: startModify },
      { name: "swarm.approvals.ask_primary", title: "Ask primary agent", category: "Swarm", run: askPrimary },
      { name: "swarm.approvals.toggle_review", title: "Toggle integration review", category: "Swarm", run: () => setShowReview((v) => !v) },
    ],
    bindings: [
      { key: "up", desc: "Previous approval", group: "Swarm", cmd: "swarm.approvals.prev" },
      { key: "down", desc: "Next approval", group: "Swarm", cmd: "swarm.approvals.next" },
      { key: "a", desc: "Approve once", group: "Swarm", cmd: "swarm.approvals.approve_once" },
      { key: "s", desc: "Approve scope", group: "Swarm", cmd: "swarm.approvals.approve_scope" },
      { key: "r", desc: "Reject", group: "Swarm", cmd: "swarm.approvals.reject" },
      { key: "m", desc: "Modify scope", group: "Swarm", cmd: "swarm.approvals.modify" },
      { key: "p", desc: "Ask primary agent", group: "Swarm", cmd: "swarm.approvals.ask_primary" },
      { key: "i", desc: "Integration review", group: "Swarm", cmd: "swarm.approvals.toggle_review" },
    ],
  }))

  useBindings(() => ({
    target: () => modifyEl(),
    enabled: () => props.store.tab === "approvals" && modifyTarget() !== undefined,
    commands: [{ name: "swarm.approvals.modify_cancel", title: "Cancel modify", category: "Swarm", run: () => setModifyTarget(undefined) }],
    bindings: [
      { key: "escape", desc: "Cancel modify", group: "Swarm", cmd: "swarm.approvals.modify_cancel" },
      { key: "return", desc: "Apply modify", group: "Swarm", cmd: () => submitModify(modifyValue()) },
    ],
  }))

  return (
    <box flexDirection="row" gap={1} minHeight={0} flexGrow={1}>
      <box flexDirection="column" gap={1} flexGrow={1} minHeight={0}>
        <box paddingLeft={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Pending approvals ({list().length})
          </text>
        </box>
        <Show when={list().length === 0}>
          <box paddingLeft={1}>
            <text fg={theme.success}>✓ no pending approvals — the swarm needs nothing from you</text>
          </box>
        </Show>
        <box flexGrow={1} minHeight={0}>
          <For each={list()}>
            {(approval) => {
              const active = approval.id === selected()
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active ? theme.primary : undefined}
                  onMouseUp={() => { setSelected(approval.id); props.setStore("selectedApprovalID", approval.id) }}
                >
                  <text flexShrink={0} fg={active ? theme.background : severityColor(theme, approval.severity)}>
                    [{severityMarker(approval.severity)}]
                  </text>
                  <text flexGrow={1} fg={active ? theme.background : theme.text} wrapMode="none" overflow="hidden">
                    {approval.summary}
                  </text>
                  <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                    {approval.action}
                  </text>
                  <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                    {approval.agentID}
                  </text>
                  <text flexShrink={0} fg={active ? theme.background : theme.textMuted}>
                    {fmtTime(snapshot().now, approval.time)}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
        <Show when={list().length > 0}>
          <text fg={theme.textMuted}>a approve once · s approve scope · m modify · r reject · p ask primary · i integration review</text>
        </Show>
      </box>

      <Show when={detail() !== undefined}>
        <box width={64} flexShrink={0} border={["left"]} borderColor={theme.border} paddingLeft={2} minHeight={0} flexDirection="column" gap={1}>
          {(() => {
            const approval = detail()!
            const agent = requestingAgent()
            const m = mission()
            return (
              <>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  {approval.id}
                </text>
                <text fg={theme.textMuted}>
                  <span style={{ fg: severityColor(theme, approval.severity), bold: true }}>[{severityMarker(approval.severity)}]</span>{" "}
                  <span style={{ fg: theme.text }}>{approval.action}</span> · risk <span style={{ fg: theme.warning }}>{approval.risk}</span> · {fmtTime(snapshot().now, approval.time)} old
                </text>
                <text fg={theme.text}>{approval.summary}</text>
                <text fg={theme.textMuted}>
                  requesting agent <span style={{ fg: theme.text }}>{approval.agentID}</span> ({agent?.role ?? "—"})
                  {agent !== undefined ? <span style={{ fg: stateColor(theme, agent.state) }}> · {agent.state}</span> : null}
                </text>
                <Show when={m !== undefined}>
                  <text fg={theme.textMuted}>
                    mission <span style={{ fg: theme.text }}>{m!.title}</span> ({approval.mission})
                  </text>
                </Show>
                <Show when={approval.resource !== undefined}>
                  <text fg={theme.textMuted}>
                    affected resource <span style={{ fg: theme.text }}>{approval.resource}</span>
                  </text>
                </Show>
                <Show when={approval.action === "budget_increase" && approval.budgetReason !== undefined}>
                  <text fg={theme.textMuted}>
                    reason <span style={{ fg: theme.text }}>{approval.budgetReason}</span>
                  </text>
                  <text fg={theme.textMuted}>
                    usage <span style={{ fg: theme.text }}>{approval.budgetUsedCalls ?? 0} calls</span> / <span style={{ fg: theme.text }}>{approval.budgetUsedTokens ?? 0} tokens</span>
                  </text>
                </Show>
                <Show when={approval.action === "integration"}>
                  <text fg={theme.textMuted} onMouseUp={() => setShowReview((v) => !v)}>
                    <span style={{ fg: theme.text }}>i</span> {showReview() ? "hide" : "show"} integration review
                  </text>
                </Show>

                <Show when={review() !== undefined}>
                  {(() => {
                    const r = review()!
                    return (
                      <box flexDirection="column" gap={1}>
                        <text fg={theme.text} attributes={TextAttributes.BOLD}>
                          Integration review — {r.title}
                        </text>
                        <text fg={theme.textMuted}>
                          {r.patchCount} patch(es) · <span style={{ fg: theme.text }}>{r.filesChanged} files</span> · {r.testsTotal} tests ({r.testsFailed} failed) · {r.reviewCount} reviews
                        </text>
                        <text fg={theme.textMuted}>
                          verdicts {Object.entries(r.verdicts).map(([v, n]) => `${v}×${n}`).join(", ") || "none"}
                        </text>
                        <Show when={r.conflicts}>
                          <text fg={theme.error}>⚠ conflicts detected — one or more reviewers rejected</text>
                        </Show>
                        <text fg={theme.textMuted}>risk: {r.risk}</text>
                        <Show when={r.files.length > 0}>
                          <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
                            files changed ({r.files.length})
                          </text>
                          <For each={r.files.slice(0, 10)}>
                            {(file) => (
                              <text fg={theme.textMuted}>
                                {file} <span style={{ fg: theme.success }}>+</span>/<span style={{ fg: theme.error }}>−</span>
                              </text>
                            )}
                          </For>
                          <Show when={r.files.length > 10}>
                            <text fg={theme.textMuted}>… {r.files.length - 10} more</text>
                          </Show>
                        </Show>
                        <Show when={r.patches.length > 0}>
                          <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
                            patches
                          </text>
                          <For each={r.patches}>
                            {(patch) => (
                              <text fg={theme.textMuted}>
                                {patch.artifactID} · {patch.files} file(s) · {patch.tests} tests {patch.testsFailed > 0 ? `(${patch.testsFailed} failed)` : ""} · {patch.verdicts.join("/") || "unreviewed"} {patch.approved ? <span style={{ fg: theme.success }}>✓</span> : ""}
                              </text>
                            )}
                          </For>
                        </Show>
                      </box>
                    )
                  })()}
                </Show>

                <Show when={modifyTarget() === approval.id}>
                  <input
                    ref={(r) => setModifyEl(r)}
                    onInput={(value) => setModifyValue(value)}
                    onSubmit={(value) => {
                      if (typeof value === "string") submitModify(value)
                    }}
                    placeholder={approval.action === "budget_increase" ? "max_model_calls:1000,max_tokens:500000" : "resource patterns (comma separated)"}
                    placeholderColor={theme.textMuted}
                    cursorColor={theme.primary}
                    cursorStyle={inputCursor}
                  />
                </Show>
                <Show when={modifyTarget() !== approval.id}>
                  <text fg={theme.textMuted}>
                    [a] approve once · [s] approve scope · [m] modify scope · [r] reject · [p] ask primary
                  </text>
                </Show>
              </>
            )
          })()}
        </box>
      </Show>
    </box>
  )
}
