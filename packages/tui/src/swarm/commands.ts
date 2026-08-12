import type { DialogContext } from "../ui/dialog"
import { openSwarmOverlay, type SwarmTab } from "./ui/overlay"

// ---------------------------------------------------------------------------
// Swarm palette commands. Registered alongside the app commands so the normal
// slash palette gains /swarm /agents /tasks /approvals /artifacts /workers
// /models /budget /why plus pause/stop. Opening the overlay never replaces the
// primary chat — it layers on top as an operations view.
// ---------------------------------------------------------------------------

type CommandEntry = {
  name: string
  title: string
  category: string
  slashName?: string
  slashAliases?: string[]
  run: () => void
  hidden?: boolean
}

export function swarmCommands(dialog: DialogContext): CommandEntry[] {
  const open = (tab: SwarmTab) => () => openSwarmOverlay(dialog, tab)
  return [
    {
      name: "swarm.open",
      title: "Open swarm operations",
      category: "Swarm",
      slashName: "swarm",
      slashAliases: ["ops", "sw"],
      run: open("overview"),
    },
    {
      name: "swarm.agents",
      title: "Swarm agents (hierarchy)",
      category: "Swarm",
      slashName: "agents",
      slashAliases: ["agent"],
      run: open("agents"),
    },
    {
      name: "swarm.tasks",
      title: "Swarm tasks",
      category: "Swarm",
      slashName: "tasks",
      slashAliases: ["task"],
      run: open("tasks"),
    },
    {
      name: "swarm.approvals",
      title: "Swarm approvals inbox",
      category: "Swarm",
      slashName: "approvals",
      slashAliases: ["approve"],
      run: open("approvals"),
    },
    {
      name: "swarm.artifacts",
      title: "Swarm artifacts",
      category: "Swarm",
      slashName: "artifacts",
      slashAliases: ["artifact", "patches"],
      run: open("artifacts"),
    },
    {
      name: "swarm.workers",
      title: "Swarm workers",
      category: "Swarm",
      slashName: "workers",
      slashAliases: ["worker"],
      run: open("workers"),
    },
    {
      name: "swarm.models",
      title: "Swarm models (human-owned policy)",
      category: "Swarm",
      slashName: "models",
      slashAliases: ["model"],
      run: open("models"),
    },
    {
      name: "swarm.budget",
      title: "Swarm budget & resources",
      category: "Swarm",
      slashName: "budget",
      slashAliases: ["limits", "resources"],
      run: open("budget"),
    },
    {
      name: "swarm.activity",
      title: "Swarm activity stream",
      category: "Swarm",
      slashName: "activity",
      slashAliases: ["feed", "events"],
      run: open("activity"),
    },
    {
      name: "swarm.why",
      title: "Swarm provenance (/why)",
      category: "Swarm",
      slashName: "why",
      slashAliases: ["provenance"],
      run: open("why"),
    },
  ]
}
