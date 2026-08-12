import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { TextAttributes, type RGBA } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { useSwarm } from "../context"
import { ServerSwarmBridge } from "../server-bridge"
import { useBindings } from "../../keymap"
import { useTerminalDimensions } from "@opentui/solid"
import { useDialog } from "../../ui/dialog"
import { SelectRow } from "./common"
import { OverviewView } from "./overview-view"
import { AgentsView } from "./agents-view"
import { TasksView } from "./tasks-view"
import { ApprovalsView } from "./approvals-view"
import { ArtifactsView } from "./artifacts-view"
import { ModelsView } from "./models-view"
import { WorkersView } from "./workers-view"
import { ActivityView } from "./activity-view"
import { BudgetView } from "./budget-view"
import { ProvenanceView } from "./provenance-view"

// ---------------------------------------------------------------------------
// SwarmOverlay: the full-screen operational layer. Mounted as a dialog on top
// of the normal chat (which stays mounted and untouched underneath). Tabs:
// Overview · Agents · Tasks · Approvals · Artifacts · Models · Workers ·
// Activity · Budget · Why. Keyboard navigation never relies on color alone.
// ---------------------------------------------------------------------------

export type SwarmTab = "overview" | "agents" | "tasks" | "approvals" | "artifacts" | "models" | "workers" | "activity" | "budget" | "why"

// Human actions exposed to the swarm views. All are safe: they route through
// the kernel's own guards and surface errors via toast instead of throwing
// into the render tree.
export interface OverlayActions {
  approveOnce: (id: string) => void
  approveScope: (id: string, scope?: { resourcePatterns?: string[] }) => void
  reject: (id: string) => void
  resolveBudget: (id: string, limits: { max_model_calls?: number; max_tokens?: number }) => void
  pauseResume: () => void
  emergencyStop: () => void
  resumeFromStop: () => void
  cancelAgent: (id: string) => void
  cancelBranch: (id: string) => void
  messageAgent: (id: string, body: string) => void
  setActiveBound: (n: number) => void
  setMissionLimits: (missionID: string, limits: { max_model_calls?: number; max_tokens?: number }) => void
  disableModel: (model: string, disabled: boolean) => void
  completeIntegration: (missionID: string) => void
}

export interface OverlayStore {
  tab: SwarmTab
  // Agents view state.
  filter: string
  stateFilter: string
  modelFilter: string
  expanded: string[]
  page: number
  pageSize: number
  selectedAgentID: string | undefined
  // Task / approval / artifact selection.
  selectedTaskID: string | undefined
  selectedApprovalID: string | undefined
  selectedArtifactID: string | undefined
  // Approval detail can expand into the integration review.
  approvalDetail: string | undefined
  provenanceFile: string
}

const TABS: readonly { id: SwarmTab; label: string; key: string }[] = [
  { id: "overview", label: "Overview", key: "1" },
  { id: "agents", label: "Agents", key: "2" },
  { id: "tasks", label: "Tasks", key: "3" },
  { id: "approvals", label: "Approvals", key: "4" },
  { id: "artifacts", label: "Artifacts", key: "5" },
  { id: "models", label: "Models", key: "6" },
  { id: "workers", label: "Workers", key: "7" },
  { id: "activity", label: "Activity", key: "8" },
  { id: "budget", label: "Budget", key: "9" },
  { id: "why", label: "Why", key: "0" },
]

export function initialOverlayStore(): OverlayStore {
  return {
    tab: "overview",
    filter: "",
    stateFilter: "all",
    modelFilter: "",
    expanded: [],
    page: 0,
    pageSize: 24,
    selectedAgentID: undefined,
    selectedTaskID: undefined,
    selectedApprovalID: undefined,
    selectedArtifactID: undefined,
    approvalDetail: undefined,
    provenanceFile: "packages/llm/parser.ts",
  }
}

export function SwarmOverlay(props: { initialTab?: SwarmTab }) {
  const { theme } = useTheme()
  const swarm = useSwarm()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const [store, setStore] = createStore<OverlayStore>({ ...initialOverlayStore(), tab: props.initialTab ?? "overview" })
  const [alerts, setAlerts] = createSignal<{ id: number; text: string; color: RGBA | string }[]>([])

  // Precise swarm-config diagnostics from the server (e.g. "swarm enabled but
  // no authorized models"). Shown instead of a bare "missing data" when the
  // bridge cannot surface real state.
  const configDiagnostics = () => {
    const bridge = swarm.bridge
    if (bridge instanceof ServerSwarmBridge) return bridge.configErrors()
    return [] as string[]
  }

  const flash = (text: string, color?: RGBA | string) => {
    const id = Date.now() + Math.random()
    setAlerts((prev) => [...prev.slice(-3), { id, text, color: color ?? theme.text }])
    setTimeout(() => setAlerts((prev) => prev.filter((a) => a.id !== id)), 3000)
  }

  const tabIndex = createMemo(() => TABS.findIndex((t) => t.id === store.tab))
  const moveTab = (direction: 1 | -1) => {
    const next = (tabIndex() + direction + TABS.length) % TABS.length
    setStore("tab", TABS[next]!.id)
  }
  const goTab = (tab: SwarmTab) => setStore("tab", tab)

  // Shared actions used by multiple views; exposed via the footer + keymap.
  const actions: OverlayActions = {
    approveOnce: (id: string) => {
      const bridge = swarm.bridge
      if (bridge === undefined) return
      try {
        bridge.approveOnce(id)
        swarm.refresh()
        flash("Approved once", theme.success)
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error), theme.error)
      }
    },
    approveScope: (id: string, scope) => {
      const bridge = swarm.bridge
      if (bridge === undefined) return
      try {
        bridge.approveScope(id, scope ?? {})
        swarm.refresh()
        flash("Approved scope", theme.success)
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error), theme.error)
      }
    },
    reject: (id: string) => {
      const bridge = swarm.bridge
      if (bridge === undefined) return
      try {
        bridge.reject(id)
        swarm.refresh()
        flash("Rejected", theme.warning)
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error), theme.error)
      }
    },
    resolveBudget: (id: string, limits) => {
      const bridge = swarm.bridge
      if (bridge === undefined) return
      try {
        bridge.resolveBudgetIncrease(id, "modify", { max_model_calls: limits.max_model_calls, max_tokens: limits.max_tokens })
        swarm.refresh()
        flash("Budget modified", theme.success)
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error), theme.error)
      }
    },
    pauseResume: () => {
      const bridge = swarm.bridge
      if (bridge === undefined) return
      try {
        if (swarm.snapshot?.paused) bridge.resume()
        else bridge.pause()
        swarm.refresh()
        flash(swarm.snapshot?.paused ? "Paused" : "Resumed", theme.info)
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error), theme.error)
      }
    },
    emergencyStop: () => {
      const bridge = swarm.bridge
      if (bridge === undefined) return
      try {
        bridge.emergencyStop()
        swarm.refresh()
        flash("EMERGENCY STOP — scheduling halted, state preserved", theme.error)
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error), theme.error)
      }
    },
    resumeFromStop: () => {
      const bridge = swarm.bridge
      if (bridge === undefined) return
      try {
        bridge.resumeFromStop()
        swarm.refresh()
        flash("Emergency stop released", theme.success)
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error), theme.error)
      }
    },
    cancelAgent: (id: string) => {
      const bridge = swarm.bridge
      if (bridge === undefined) return
      try {
        bridge.cancelAgent(id)
        swarm.refresh()
        flash(`Cancelled ${id}`, theme.warning)
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error), theme.error)
      }
    },
    cancelBranch: (id: string) => {
      const bridge = swarm.bridge
      if (bridge === undefined) return
      try {
        bridge.cancelBranch(id)
        swarm.refresh()
        flash(`Cancelled branch ${id}`, theme.warning)
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error), theme.error)
      }
    },
    messageAgent: (id: string, body: string) => {
      const bridge = swarm.bridge
      if (bridge === undefined) return
      try {
        bridge.injectMessage(id, body)
        swarm.refresh()
        flash(`Message sent to ${id}`, theme.info)
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error), theme.error)
      }
    },
    setActiveBound: (n: number) => {
      const bridge = swarm.bridge
      if (bridge === undefined) return
      try {
        bridge.setActiveBound(n)
        swarm.refresh()
        flash(`Active bound → ${n}`, theme.info)
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error), theme.error)
      }
    },
    setMissionLimits: (missionID: string, limits) => {
      const bridge = swarm.bridge
      if (bridge === undefined) return
      try {
        bridge.setMissionBudgetLimits(missionID, { max_model_calls: limits.max_model_calls, max_tokens: limits.max_tokens })
        swarm.refresh()
        flash("Mission budget limits updated", theme.info)
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error), theme.error)
      }
    },
    disableModel: (model: string, disabled: boolean) => {
      const bridge = swarm.bridge
      if (bridge === undefined) return
      try {
        bridge.disableModel(model, disabled)
        swarm.refresh()
        flash(`${model} ${disabled ? "disabled" : "enabled"}`, theme.info)
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error), theme.error)
      }
    },
    completeIntegration: (missionID: string) => {
      const bridge = swarm.bridge
      if (bridge === undefined) return
      try {
        bridge.completeIntegration(missionID)
        swarm.refresh()
        flash("Integration applied", theme.success)
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error), theme.error)
      }
    },
  }

  useBindings(() => ({
    commands: [
      {
        name: "swarm.tab.next",
        title: "Next swarm tab",
        category: "Swarm",
        run: () => moveTab(1),
      },
      {
        name: "swarm.tab.prev",
        title: "Previous swarm tab",
        category: "Swarm",
        run: () => moveTab(-1),
      },
      {
        name: "swarm.overview",
        title: "Swarm overview",
        category: "Swarm",
        run: () => goTab("overview"),
      },
      {
        name: "swarm.agents",
        title: "Swarm agents",
        category: "Swarm",
        run: () => goTab("agents"),
      },
      {
        name: "swarm.approvals",
        title: "Swarm approvals",
        category: "Swarm",
        run: () => goTab("approvals"),
      },
      {
        name: "swarm.tasks",
        title: "Swarm tasks",
        category: "Swarm",
        run: () => goTab("tasks"),
      },
      {
        name: "swarm.artifacts",
        title: "Swarm artifacts",
        category: "Swarm",
        run: () => goTab("artifacts"),
      },
      {
        name: "swarm.models",
        title: "Swarm models",
        category: "Swarm",
        run: () => goTab("models"),
      },
      {
        name: "swarm.workers",
        title: "Swarm workers",
        category: "Swarm",
        run: () => goTab("workers"),
      },
      {
        name: "swarm.activity",
        title: "Swarm activity",
        category: "Swarm",
        run: () => goTab("activity"),
      },
      {
        name: "swarm.budget",
        title: "Swarm budget",
        category: "Swarm",
        run: () => goTab("budget"),
      },
      {
        name: "swarm.why",
        title: "Swarm provenance (/why)",
        category: "Swarm",
        run: () => goTab("why"),
      },
      {
        name: "swarm.pause",
        title: "Pause / resume swarm",
        category: "Swarm",
        run: actions.pauseResume,
      },
      {
        name: "swarm.emergency_stop",
        title: "Emergency stop",
        category: "Swarm",
        run: actions.emergencyStop,
      },
      {
        name: "swarm.resume_from_stop",
        title: "Resume from emergency stop",
        category: "Swarm",
        run: actions.resumeFromStop,
      },
    ],
    bindings: [
      { key: "tab", desc: "Next tab", group: "Swarm", cmd: () => moveTab(1) },
      { key: "shift+tab", desc: "Previous tab", group: "Swarm", cmd: () => moveTab(-1) },
      { key: "1", desc: "Overview", group: "Swarm", cmd: () => goTab("overview") },
      { key: "2", desc: "Agents", group: "Swarm", cmd: () => goTab("agents") },
      { key: "3", desc: "Tasks", group: "Swarm", cmd: () => goTab("tasks") },
      { key: "4", desc: "Approvals", group: "Swarm", cmd: () => goTab("approvals") },
      { key: "5", desc: "Artifacts", group: "Swarm", cmd: () => goTab("artifacts") },
      { key: "6", desc: "Models", group: "Swarm", cmd: () => goTab("models") },
      { key: "7", desc: "Workers", group: "Swarm", cmd: () => goTab("workers") },
      { key: "8", desc: "Activity", group: "Swarm", cmd: () => goTab("activity") },
      { key: "9", desc: "Budget", group: "Swarm", cmd: () => goTab("budget") },
      { key: "0", desc: "Why", group: "Swarm", cmd: () => goTab("why") },
      { key: "escape", desc: "Close swarm overlay", group: "Swarm", cmd: () => dialog.clear() },
      { key: "ctrl+c", desc: "Close swarm overlay", group: "Swarm", cmd: () => dialog.clear() },
    ],
  }))

  const contentHeight = () => Math.max(8, dimensions().height - 10)

  return (
    <box flexDirection="column" gap={1} paddingBottom={1} minHeight={0} flexGrow={1}>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          ⛧ openSwarm Operations
        </text>
        <text fg={theme.textMuted}>esc close · tab switch · 1-9/0 tabs</text>
      </box>
      <Show when={swarm.snapshot === undefined}>
        <box paddingLeft={2}>
          <text fg={theme.textMuted}>Loading swarm…</text>
        </box>
      </Show>
      <Show when={swarm.error !== undefined}>
        <box paddingLeft={2}>
          <text fg={theme.error}>swarm: {swarm.error}</text>
        </box>
      </Show>
      <Show when={configDiagnostics().length > 0}>
        <box paddingLeft={2} flexDirection="column" gap={1}>
          <For each={configDiagnostics()}>
            {(msg) => (
              <text fg={theme.warning}>swarm config: {msg}</text>
            )}
          </For>
        </box>
      </Show>
      <Show when={swarm.snapshot !== undefined}>
        <box flexDirection="column" gap={1} flexGrow={1} minHeight={0}>
          <box flexDirection="row" gap={1} paddingLeft={2} paddingRight={2} flexWrap="wrap">
            <For each={TABS}>
              {(tab) => (
                <SelectRow active={store.tab === tab.id} onClick={() => goTab(tab.id)}>
                  <text fg={store.tab === tab.id ? theme.background : theme.textMuted}>
                    {tab.key} {tab.label}
                  </text>
                </SelectRow>
              )}
            </For>
          </box>
          <Show when={alerts().length > 0}>
            <box flexDirection="column" paddingLeft={2} paddingRight={2}>
              <For each={alerts()}>
                {(alert) => (
                  <text fg={alert.color}>
                    ⚠ {alert.text}
                  </text>
                )}
              </For>
            </box>
          </Show>
          <box flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1}>
            <Switch>
              <Match when={store.tab === "overview"}>
                <OverviewView store={store} setStore={setStore} actions={actions} height={contentHeight()} />
              </Match>
              <Match when={store.tab === "agents"}>
                <AgentsView store={store} setStore={setStore} actions={actions} height={contentHeight()} />
              </Match>
              <Match when={store.tab === "tasks"}>
                <TasksView store={store} setStore={setStore} actions={actions} height={contentHeight()} />
              </Match>
              <Match when={store.tab === "approvals"}>
                <ApprovalsView store={store} setStore={setStore} actions={actions} height={contentHeight()} />
              </Match>
              <Match when={store.tab === "artifacts"}>
                <ArtifactsView store={store} setStore={setStore} actions={actions} height={contentHeight()} />
              </Match>
              <Match when={store.tab === "models"}>
                <ModelsView store={store} setStore={setStore} actions={actions} height={contentHeight()} />
              </Match>
              <Match when={store.tab === "workers"}>
                <WorkersView store={store} setStore={setStore} actions={actions} height={contentHeight()} />
              </Match>
              <Match when={store.tab === "activity"}>
                <ActivityView store={store} setStore={setStore} actions={actions} height={contentHeight()} />
              </Match>
              <Match when={store.tab === "budget"}>
                <BudgetView store={store} setStore={setStore} actions={actions} height={contentHeight()} />
              </Match>
              <Match when={store.tab === "why"}>
                <ProvenanceView store={store} setStore={setStore} actions={actions} height={contentHeight()} />
              </Match>
            </Switch>
          </box>
        </box>
      </Show>
    </box>
  )
}

export function openSwarmOverlay(dialog: ReturnType<typeof useDialog>, tab?: SwarmTab) {
  dialog.setSize("xlarge")
  dialog.replace(() => <SwarmOverlay initialTab={tab} />)
}
