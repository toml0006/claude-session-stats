export type Proc = {
  pid: number
  ppid: number
  depth: number
  cpu: number
  rssKb: number
  elapsed: string
  name: string
}

export type Snapshot = {
  rootPid: number
  rootName: string
  cores: number
  memBytes: number
  load: number[]
  cpu: number
  rssKb: number
  procs: Proc[]
}

export type Stats = {
  snapshot: Snapshot | null
  error: string | null
  cpuHistory: number[]
  ramHistory: number[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-stats': { stats: Stats; isBarOn: boolean }
  }
}
