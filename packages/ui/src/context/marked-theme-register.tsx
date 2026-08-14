import { registerCustomTheme } from "@pierre/diffs"
import { openSwarmTheme } from "./marked-theme"

let registered = false

export function registeropenSwarmTheme() {
  if (registered) return
  registered = true
  registerCustomTheme("openSwarm", () => Promise.resolve(openSwarmTheme))
}
