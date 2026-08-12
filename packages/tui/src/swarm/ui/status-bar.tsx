import { Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSwarm } from "../context"
import { TextAttributes } from "@opentui/core"

// Compact one-line swarm status. Rendered at the bottom of the app so the
// operator always knows: how big is the swarm, how much is executing, are
// approvals or an emergency waiting. The primary chat stays dominant above.
export function SwarmStatusBar() {
  const { theme } = useTheme()
  const swarm = useSwarm()

  const compact = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
    return String(n)
  }

  const fg = () => {
    if (swarm.snapshot?.emergencyStopped) return theme.error
    if ((swarm.snapshot?.approvals.length ?? 0) > 0) return theme.warning
    return theme.textMuted
  }

  return (
    <Show when={swarm.snapshot}>
      {(snapshot) => {
        const s = snapshot()
        return (
          <box flexDirection="row" gap={1} flexShrink={0}>
            <text fg={fg()} attributes={TextAttributes.BOLD}>
              SWARM
            </text>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.text }}>{compact(s.agents.length)}</span> agents
            </text>
            <text fg={theme.textMuted}>│</text>
            <text fg={theme.textMuted}>
              <span style={{ fg: s.counts.running > 0 ? theme.success : theme.textMuted }}>{compact(s.counts.running)}</span>{" "}
              active
            </text>
            <text fg={theme.textMuted}>│</text>
            <Show when={s.counts.queued > 0}>
              <text fg={theme.textMuted}>
                <span style={{ fg: theme.text }}>{compact(s.counts.queued)}</span> queued
              </text>
              <text fg={theme.textMuted}>│</text>
            </Show>
            <Show when={s.counts.failed > 0}>
              <text fg={theme.textMuted}>
                <span style={{ fg: theme.error }}>{compact(s.counts.failed)}</span> failed
              </text>
              <text fg={theme.textMuted}>│</text>
            </Show>
            <Show when={s.approvals.length > 0}>
              <text fg={theme.warning}>
                <span style={{ fg: theme.warning, bold: true }}>{s.approvals.length}</span> approval
                {s.approvals.length > 1 ? "s" : ""}
              </text>
              <text fg={theme.textMuted}>│</text>
            </Show>
            <Show when={s.paused}>
              <text fg={theme.warning}>PAUSED</text>
              <text fg={theme.textMuted}>│</text>
            </Show>
            <Show when={s.emergencyStopped}>
              <text fg={theme.error} attributes={TextAttributes.BOLD}>
                ⛔ EMERGENCY STOP
              </text>
              <text fg={theme.textMuted}>│</text>
            </Show>
            <Show when={s.resources[0] !== undefined}>
              <text fg={theme.textMuted}>
                budget{" "}
                <span
                  style={{
                    fg:
                      s.resources[0]!.threshold === "hard"
                        ? theme.error
                        : s.resources[0]!.threshold === "soft"
                          ? theme.warning
                          : theme.success,
                  }}
                >
                  {Math.round(s.resources[0]!.tokenBudget.ratio * 100)}%
                </span>
              </text>
            </Show>
            <text fg={theme.textMuted}>/swarm</text>
          </box>
        )
      }}
    </Show>
  )
}
