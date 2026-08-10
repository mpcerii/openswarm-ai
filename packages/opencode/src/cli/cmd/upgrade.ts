import { UI } from "../ui"
import * as prompts from "@clack/prompts"

// openSwarm has no release channel: self-upgrade would fetch upstream OpenCode
// releases and silently replace this fork, so the command only explains how to
// update from source.
export const UpgradeCommand = {
  command: "upgrade",
  describe: "explain how to update an openSwarm source build",
  handler: async () => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    prompts.log.warn("openSwarm does not self-update: there is no openSwarm release channel.")
    prompts.log.info("Update by pulling this repository and rebuilding from source.")
    prompts.outro("Done")
  },
}
