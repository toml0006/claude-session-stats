import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { Stats } from '../types'
import { PROBE, gb, parseProbe, sparkline } from './stats'

const PANE = 'session-stats'
const PERIOD_MS = 2000
const HISTORY = 60
const stats = atom({ plugin: 'session-stats', key: 'stats' } as const, {
  snapshot: null,
  error: null,
  cpuHistory: [],
  ramHistory: [],
} as Stats)

export const register: Register = on => {
  // Polls only while the pane is open; a reload drops it, and the next
  // /session-stats starts it again.
  let timer: Timer | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-stats',
      description: 'Show live CPU, RAM and processes of this session in a pane',
    })
    return next(e)
  })

  on('command.run', { command: 'session-stats' }, async $ => {
    const sample = async () => {
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

    const opened = await $.ui.open({ id: PANE, title: 'Session stats' })
    if (!opened.isPlaced) return { text: `Session stats pane not shown: ${opened.reason}` }
    await sample()
    timer ??= $.clock.every(PERIOD_MS, () => void sample())

    return { text: 'Session stats pane opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    timer?.cancel()
    timer = undefined
    return next(e)
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
          <Text color={s.cpu >= 100 ? 'red' : s.cpu >= 50 ? 'yellow' : 'green'}>{s.cpu.toFixed(0)}%</Text>
          <Text dimColor> ({machinePct}% of {s.cores} cores)</Text>
        </Text>
        <Text color="cyan">{sparkline(cpuHistory.slice(-spark))}</Text>
        <Text>
          <Text bold>RAM </Text>
          <Text color={s.rssKb >= 4194304 ? 'red' : s.rssKb >= 2097152 ? 'yellow' : 'green'}>{gb(s.rssKb)} GB</Text>
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
