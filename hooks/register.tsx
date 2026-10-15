import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Io, Stats } from '../types'
import type { Counters } from './stats'
import { NET_PROBE, PROBE, bytes, gb, ioProbe, parseNettop, parseProbe, parseRusage, rates, sparkline } from './stats'

const PANE = 'session-stats'
const PERIOD_MS = 2000
const HISTORY = 120
// Each history in the bar is at most this many cells (one minute of samples)
const BAR_SPAN = 30
const BAR_KEY = 'bar'
const EMPTY: Stats = {
  snapshot: null,
  error: null,
  cpuHistory: [],
  ramHistory: [],
  io: null,
  isRusageAvailable: true,
  net: null,
  netHistory: [],
  diskHistory: [],
  energyHistory: [],
}
const stats = atom({ plugin: 'session-stats', key: 'stats' } as const, EMPTY)
const isBarOn = atom({ plugin: 'session-stats', key: 'isBarOn' } as const, false)

const cpuColor = (cpu: number) => (cpu >= 100 ? 'red' : cpu >= 50 ? 'yellow' : 'green')
const ramColor = (kb: number) => (kb >= 4194304 ? 'red' : kb >= 2097152 ? 'yellow' : 'green')

// One sampler serves both the bar and the pane, and runs only while either
// is showing. A reload resets these; session.start restarts it for the bar.
let timer: Timer | undefined
let isPaneOpen = false

// The previous cumulative counters, to turn the next ones into rates
let prevRusage: { at: number; counters: Counters } | undefined
let prevNet: { at: number; counters: Counters } | undefined
let isNetBusy = false

const push = (list: readonly number[], v: number) => [...list, v].slice(-HISTORY)

// The host keeps $.state across reloads and updates, so a value written by an
// older version can lack fields this one reads: fill them in on every read.
async function readStats($: EngineInterface): Promise<Stats> {
  return { ...EMPTY, ...(await read($, stats)) }
}

async function updateStats($: EngineInterface, fn: (s: Stats) => Stats) {
  await update($, stats, s => fn({ ...EMPTY, ...s }))
}

async function sample($: EngineInterface) {
  try {
    const { stdout } = await $.process.run(PROBE, { env: { LC_ALL: 'C' }, timeoutMs: 5000 })
    const snap = parseProbe(stdout)
    const pids = snap.procs.map(p => p.pid)

    const probe = ioProbe(pids)
    const usage = parseRusage((await $.process.run(probe.argv, { env: probe.env, timeoutMs: 5000 })).stdout)
    const at = await $.clock.now()
    let io: Io | null = null
    let seconds = 0
    if (prevRusage && usage.size > 0) {
      seconds = (at - prevRusage.at) / 1000
      const { total, perPid } = rates(prevRusage.counters, usage, seconds, pids)
      const hasEnergy = [...usage.values()].every(c => (c[2] ?? -1) >= 0)
      for (const p of snap.procs) {
        const r = perPid.get(p.pid)
        p.watts = r && hasEnergy ? (r[2] ?? 0) / 1e9 : null
      }
      const watts = hasEnergy ? (total[2] ?? 0) / 1e9 : 0
      io = { diskRead: total[0] ?? 0, diskWrite: total[1] ?? 0, watts, hasEnergy, joules: 0 }
    }
    prevRusage = usage.size > 0 ? { at, counters: usage } : undefined

    await updateStats($, s => ({
      ...s,
      snapshot: snap,
      error: null,
      cpuHistory: push(s.cpuHistory, snap.cpu),
      ramHistory: push(s.ramHistory, snap.rssKb),
      isRusageAvailable: usage.size > 0,
      io: io ? { ...io, joules: (s.io?.joules ?? 0) + io.watts * seconds } : s.io,
      diskHistory: io ? push(s.diskHistory, io.diskRead + io.diskWrite) : s.diskHistory,
      energyHistory: io?.hasEnergy ? push(s.energyHistory, io.watts) : s.energyHistory,
    }))
    if (!isNetBusy) void sampleNet($, pids)
  } catch (err) {
    await updateStats($, s => ({ ...s, error: String(err) }))
  }
}

async function sampleNet($: EngineInterface, pids: readonly number[]) {
  isNetBusy = true
  try {
    const counters = parseNettop((await $.process.run(NET_PROBE, { timeoutMs: 15000 })).stdout)
    const at = await $.clock.now()
    if (prevNet) {
      const { total } = rates(prevNet.counters, counters, (at - prevNet.at) / 1000, pids)
      const net = { bytesIn: total[0] ?? 0, bytesOut: total[1] ?? 0 }
      await updateStats($, s => ({ ...s, net, netHistory: push(s.netHistory, net.bytesIn + net.bytesOut) }))
    }
    prevNet = { at, counters }
  } catch {
    // Network is a nice-to-have: a failed nettop leaves the last reading
  } finally {
    isNetBusy = false
  }
}

async function syncSampler($: EngineInterface) {
  const isNeeded = isPaneOpen || (await read($, isBarOn))
  if (isNeeded && !timer) {
    await sample($)
    timer = $.clock.every(PERIOD_MS, () => void sample($))
  } else if (!isNeeded && timer) {
    timer.cancel()
    timer = undefined
  }
}

// Closes the pane, turns the bar off (remembered), and stops every sampler
async function stopAll($: EngineInterface) {
  isPaneOpen = false
  await $.store.set(BAR_KEY, false)
  await update($, isBarOn, () => false)
  await syncSampler($)
  prevRusage = undefined
  prevNet = undefined
  await $.ui.close({ id: PANE }).catch(() => undefined)
  return 'Session stats stopped: pane closed, bar off, nothing sampling. /session-stats starts it again.'
}

async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: 'Session stats' })
  if (!opened.isPlaced) return `Session stats pane not shown: ${opened.reason}`
  isPaneOpen = true
  await syncSampler($)
  return 'Session stats pane opened.'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-stats',
      description: 'Show live CPU, RAM and processes of this session; "bar" toggles the strip above the prompt, "stop" shuts everything off',
      argumentHint: '[bar [on|off] | stop]',
    })
    const isOn = (await $.store.get(BAR_KEY)) === true
    await update($, isBarOn, () => isOn)
    // A reload keeps an open pane open but forgets it here; ask, so it keeps updating
    isPaneOpen = await $.ui
      .panes()
      .then(panes => panes.some(pane => pane.id === PANE))
      .catch(() => false)
    await syncSampler($)
    return next(e)
  })

  on('command.run', { command: 'session-stats' }, async ($, e) => {
    const [sub, arg] = e.args.trim().split(/\s+/)
    if (sub === 'stop' || sub === 'off' || sub === 'kill') return { text: await stopAll($) }
    if (sub !== 'bar') return { text: await openPane($) }

    const isOn = arg === 'on' ? true : arg === 'off' ? false : !(await read($, isBarOn))
    await $.store.set(BAR_KEY, isOn)
    await update($, isBarOn, () => isOn)
    await syncSampler($)
    return { text: `Session stats bar ${isOn ? 'on' : 'off'}.` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    isPaneOpen = false
    await syncSampler($)
    return next(e)
  })

  // The strip above the prompt: numbers first, then each history at its full
  // width from the first sample, filling left to right and then scrolling. One
  // Button, so a click anywhere on it opens the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isBarOn))) return next(e)

    const { Button, Text } = $.ui.resolve(e)
    const { snapshot: s, cpuHistory, ramHistory } = await readStats($)
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    // "⚙ CPU 100% " + " " + " RAM 10.0G " + " " is 26 cells around the two histories
    const span = Math.max(6, Math.min(BAR_SPAN, Math.floor((width - 26) / 2)))
    const cpu = sparkline(cpuHistory.slice(-span))
    const ram = sparkline(ramHistory.slice(-span))

    return (
      <Button key="open-pane" plain onPress={() => void openPane($)}>
        <Text dimColor>⚙ CPU </Text>
        <Text color={cpuColor(s?.cpu ?? 0)}>{(s ? `${s.cpu.toFixed(0)}%` : '…').padStart(4)} </Text>
        <Text color="cyan">{cpu}</Text>
        <Text dimColor>{'·'.repeat(span - cpu.length)}  RAM </Text>
        <Text color={ramColor(s?.rssKb ?? 0)}>{(s ? `${gb(s.rssKb)}G` : '…').padStart(5)} </Text>
        <Text color="magenta">{ram}</Text>
        <Text dimColor>{'·'.repeat(span - ram.length)}</Text>
      </Button>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const { snapshot: s, error, cpuHistory, ramHistory, io, net, netHistory, diskHistory, energyHistory, isRusageAvailable } =
      await readStats($)
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const noRusage = isRusageAvailable ? null : 'needs the Xcode Command Line Tools'

    if (!s) return <Text dimColor>{error ?? 'Sampling…'}</Text>

    const machinePct = (s.cpu / s.cores).toFixed(0)
    const ramPct = ((s.rssKb * 1024 * 100) / s.memBytes).toFixed(1)
    const spark = Math.max(10, Math.min(HISTORY, width - 14))
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 18)
    const nameCols = Math.max(10, width - 31)
    const pad = (v: string, n: number) => v.padStart(n)

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>CPU </Text>
          <Text color={cpuColor(s.cpu)}>{s.cpu.toFixed(0)}%</Text>
          <Text dimColor> ({machinePct}% of {s.cores} cores)</Text>
        </Text>
        <Text color="cyan">{sparkline(cpuHistory.slice(-spark))}</Text>
        <Text>
          <Text bold>RAM </Text>
          <Text color={ramColor(s.rssKb)}>{gb(s.rssKb)} GB</Text>
          <Text dimColor> ({ramPct}% of {gb(s.memBytes / 1024)} GB)</Text>
        </Text>
        <Text color="magenta">{sparkline(ramHistory.slice(-spark))}</Text>
        <Text>
          <Text bold>NET </Text>
          {net ? `↓ ${bytes(net.bytesIn)}/s  ↑ ${bytes(net.bytesOut)}/s` : <Text dimColor>measuring…</Text>}
        </Text>
        <Text color="blue">{sparkline(netHistory.slice(-spark))}</Text>
        <Text>
          <Text bold>DISK </Text>
          {io ? `read ${bytes(io.diskRead)}/s  write ${bytes(io.diskWrite)}/s` : <Text dimColor>{noRusage ?? 'measuring…'}</Text>}
        </Text>
        <Text color="yellow">{sparkline(diskHistory.slice(-spark))}</Text>
        <Text>
          <Text bold>ENERGY </Text>
          {io?.hasEnergy ? `${io.watts.toFixed(2)} W` : <Text dimColor>{io ? 'needs macOS 13 or later' : noRusage ?? 'measuring…'}</Text>}
          {io?.hasEnergy && <Text dimColor> ({io.joules.toFixed(0)} J since sampling began)</Text>}
        </Text>
        <Text color="red">{sparkline(energyHistory.slice(-spark))}</Text>
        <Text dimColor>
          {s.procs.length} processes · session pid {s.rootPid} up {s.procs[0]?.elapsed} · load {s.load.map(l => l.toFixed(2)).join(' ')}
        </Text>
        <Text> </Text>
        <Text bold>{'  PID  CPU%   MEM     W NAME'}</Text>
        {s.procs.slice(0, room).map(p => (
          <Text>
            {pad(String(p.pid), 5)} {pad(p.cpu.toFixed(1), 5)} {pad(gb(p.rssKb) + 'G', 5)} {pad(p.watts == null ? '–' : p.watts.toFixed(2), 5)}{' '}
            <Text dimColor={p.cpu < 1}>{('  '.repeat(p.depth) + p.name).slice(0, nameCols)}</Text>
          </Text>
        ))}
        {s.procs.length > room && <Text dimColor>…{s.procs.length - room} more</Text>}
        {error && <Text color="red">last sample failed: {error}</Text>}
      </Box>
    )
  })
}
