import { useTheme } from "../../context/theme"
import type { AlertSeverity, ApprovalSeverity } from "../state/types"
import { TextAttributes } from "@opentui/core"
import type { ParentProps } from "solid-js"

// Shared presentation helpers for the swarm overlay: severity/state colors and
// compact number formatting. Colors are an accelerator, never the only signal —
// every severity also carries a textual marker.

export function severityColor(theme: ReturnType<typeof useTheme>["theme"], severity: AlertSeverity | ApprovalSeverity) {
  if (severity === "critical" || severity === "HIGH") return theme.error
  if (severity === "high") return theme.error
  if (severity === "warning" || severity === "MEDIUM") return theme.warning
  return theme.textMuted
}

export function severityMarker(severity: AlertSeverity | ApprovalSeverity): string {
  if (severity === "critical") return "CRIT"
  if (severity === "HIGH" || severity === "high") return "HIGH"
  if (severity === "warning" || severity === "MEDIUM") return "MED "
  return "info"
}

export function stateColor(theme: ReturnType<typeof useTheme>["theme"], state: string) {
  if (state === "running" || state === "completed") return theme.success
  if (state === "failed" || state === "cancelled") return theme.error
  if (state === "awaiting_approval" || state === "blocked" || state === "waiting") return theme.warning
  if (state === "queued") return theme.info
  return theme.textMuted
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function fmtTime(now: number, time: number): string {
  const delta = Math.max(0, now - time)
  if (delta < 1_000) return "now"
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`
  return `${Math.floor(delta / 3_600_000)}h`
}

export function bold(text: string, color?: string) {
  return { text, color, attrs: TextAttributes.BOLD }
}

// Highlighted selectable row. Text elements have no background; the wrapper
// box carries the selection highlight so rows stay readable in any theme.
export function SelectRow(props: ParentProps<{ active: boolean; onClick?: () => void }>) {
  const { theme } = useTheme()
  return (
    <box
      flexDirection="row"
      gap={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.active ? theme.primary : undefined}
      onMouseUp={props.onClick}
    >
      {props.children}
    </box>
  )
}

// Cursor style options accepted by the input renderable (config provides the
// canonical one; this mirrors it so inputs are consistent).
export const inputCursor = { style: "block" } as const
