import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Stats } from '../types'
import { PROBE, gb, parseProbe, sparkline } from './stats'

const PANE = 'session-stats'
const PERIOD_MS = 2000
const HISTORY = 60
const BAR_KEY = 'bar'
const stats = atom({ plugin: 'session-stats', key: 'stats' } as const, {
  snapshot: null,
  error: null,
  cpuHistory: [],
  ramHistory: [],
} as Stats)
const isBarOn = atom({ plugin: 'session-stats', key: 'isBarOn' } as const, false)

const cpuColor = (cpu: number) => (cpu >= 100 ? 'red' : cpu >= 50 ? 'yellow' : 'green')
const ramColor = (kb: number) => (kb >= 4194304 ? 'red' : kb >= 2097152 ? 'yellow' : 'green')

// One sampler serves both the bar and the pane, and runs only while either
// is showing. A reload resets these; session.start restarts it for the bar.
let timer: Timer | undefined
let isPaneOpen = false

async function sample($: EngineInterface) {
  try {
    const { stdout } = await $.process.run(PROBE, { env: { LC_ALL: 'C' }, timeoutMs: 5000 })
    const snap = parseProbe(stdout)
    await update($, stats, s => ({
      snapshot: snap,
      error: null,
      cpuHistory: [...s.cpuHistory, snap.cpu].slice(-HISTORY),
      ramHistory: [...s.ramHistory, snap.rssKb].slice(-HISTORY),
    }))
  } catch (err) {
    await update($, stats, s => ({ ...s, error: String(err) }))
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
      description: 'Show live CPU, RAM and processes of this session; "bar" toggles the strip above the prompt',
      argumentHint: '[bar [on|off]]',
    })
    const isOn = (await $.store.get(BAR_KEY)) === true
    await update($, isBarOn, () => isOn)
    await syncSampler($)
    return next(e)
  })

  on('command.run', { command: 'session-stats' }, async ($, e) => {
    const [sub, arg] = e.args.trim().split(/\s+/)
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

  // The strip above the prompt: one Button, so a click anywhere on it opens the pane
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isBarOn))) return next(e)

    const { Button, Text } = $.ui.resolve(e)
    const { snapshot: s, cpuHistory, ramHistory } = await read($, stats)
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    const spark = Math.max(6, Math.min(30, Math.floor((width - 34) / 2)))

    return (
      <Button key="open-pane" plain onPress={() => void openPane($)}>
        <Text dimColor>⚙ CPU </Text>
        <Text color="cyan">{sparkline(cpuHistory.slice(-spark))}</Text>
        <Text color={cpuColor(s?.cpu ?? 0)}> {s ? `${s.cpu.toFixed(0)}%` : '…'}</Text>
        <Text dimColor> · RAM </Text>
        <Text color="magenta">{sparkline(ramHistory.slice(-spark))}</Text>
        <Text color={ramColor(s?.rssKb ?? 0)}> {s ? `${gb(s.rssKb)}G` : '…'}</Text>
      </Button>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const { snapshot: s, error, cpuHistory, ramHistory } = await read($, stats)
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 80

    if (!s) return <Text dimColor>{error ?? 'Sampling…'}</Text>

    const machinePct = (s.cpu / s.cores).toFixed(0)
    const ramPct = ((s.rssKb * 1024 * 100) / s.memBytes).toFixed(1)
    const spark = Math.max(10, Math.min(HISTORY, width - 14))
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 12)
    const nameCols = Math.max(10, width - 30)
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
        <Text dimColor>
          {s.procs.length} processes · session pid {s.rootPid} up {s.procs[0]?.elapsed} · load {s.load.map(l => l.toFixed(2)).join(' ')}
        </Text>
        <Text> </Text>
        <Text bold>{'  PID   CPU%    MEM  NAME'}</Text>
        {s.procs.slice(0, room).map(p => (
          <Text>
            {pad(String(p.pid), 5)} {pad(p.cpu.toFixed(1), 6)} {pad(gb(p.rssKb) + 'G', 6)}{'  '}
            <Text dimColor={p.cpu < 1}>{('  '.repeat(p.depth) + p.name).slice(0, nameCols)}</Text>
          </Text>
        ))}
        {s.procs.length > room && <Text dimColor>…{s.procs.length - room} more</Text>}
        {error && <Text color="red">last sample failed: {error}</Text>}
      </Box>
    )
  })
}
