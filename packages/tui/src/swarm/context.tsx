import { createContext, onCleanup, onMount, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { SwarmBridge } from "./bridge"
import { ServerSwarmBridge } from "./server-bridge"
import { useSDK } from "../context/sdk"
import type { SwarmUiSnapshot } from "./state/types"

// ---------------------------------------------------------------------------
// SwarmProvider: owns the swarm bridge and publishes a reactive snapshot. The
// bridge reads REAL runtime state from the opencode server (/swarm/status +
// /swarm/agents) so `/swarm` shows the actual scheduler — population, active
// bounds, approved models, per-agent states. The demo-seeded in-process kernel
// is no longer mounted. Actions (approve/reject/cancel/pause) are only shown
// when a corresponding server endpoint exists; mutation endpoints are the next
// milestone.
// ---------------------------------------------------------------------------

interface SwarmContextValue {
  bridge: SwarmBridge | ServerSwarmBridge | undefined
  snapshot: SwarmUiSnapshot | undefined
  ready: boolean
  error: string | undefined
  refresh: () => void
}

const ctx = createContext<SwarmContextValue>()

export function SwarmProvider(props: ParentProps) {
  const sdk = useSDK()
  const [store, setStore] = createStore<{
    bridge: SwarmBridge | ServerSwarmBridge | undefined
    snapshot: SwarmUiSnapshot | undefined
    ready: boolean
    error: string | undefined
  }>({ bridge: undefined, snapshot: undefined, ready: false, error: undefined })

  const refresh = () => {
    const bridge = store.bridge
    if (bridge === undefined) return
    try {
      if (bridge instanceof ServerSwarmBridge) {
        setStore("snapshot", bridge.snapshot())
        setStore("error", bridge.error())
      } else {
        setStore("snapshot", bridge.snapshot())
        setStore("error", undefined)
      }
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
    }
  }

  onMount(async () => {
    try {
      // Real server-backed bridge. The demo kernel is NOT used.
      const bridge = new ServerSwarmBridge({
        fetch: sdk.fetch,
        url: sdk.url,
        directory: sdk.directory,
        onMutate: refresh,
      })
      await bridge.tick()
      setStore("bridge", bridge)
      refresh()
      setStore("ready", true)
      const timer = setInterval(() => {
        void (async () => {
          await bridge.tick()
          refresh()
        })()
      }, 1500)
      onCleanup(() => {
        clearInterval(timer)
        bridge.dispose()
      })
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
      setStore("ready", true)
    }
  })

  return (
    <ctx.Provider
      value={{
        get bridge() {
          return store.bridge
        },
        get snapshot() {
          return store.snapshot
        },
        get ready() {
          return store.ready
        },
        get error() {
          return store.error
        },
        refresh,
      }}
    >
      {props.children}
    </ctx.Provider>
  )
}

export function useSwarm(): SwarmContextValue {
  const value = useContext(ctx)
  if (value === undefined) throw new Error("useSwarm must be used within a SwarmProvider")
  return value
}