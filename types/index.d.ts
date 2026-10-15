export type Proc = {
  pid: number
  ppid: number
  depth: number
  cpu: number
  rssKb: number
  elapsed: string
  name: string
  /** Average power over the last sample, in watts; null until two samples */
  watts: number | null
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

/** Rates over the last sample, per second, for the whole tree */
export type Io = {
  /** Disk bytes read and written per second, and watts; null without rusage */
  diskRead: number
  diskWrite: number
  watts: number
  /** False before macOS 13, where per-process energy is not reported */
  hasEnergy: boolean
  /** Energy since the pane or bar started sampling, in joules */
  joules: number
}

export type Net = { bytesIn: number; bytesOut: number }

export type Stats = {
  snapshot: Snapshot | null
  error: string | null
  cpuHistory: number[]
  ramHistory: number[]
  /** null until two rusage samples; also null where rusage is unavailable */
  io: Io | null
  isRusageAvailable: boolean
  /** null until two nettop samples */
  net: Net | null
  netHistory: number[]
  diskHistory: number[]
  energyHistory: number[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-stats': { stats: Stats; isBarOn: boolean }
  }
}
