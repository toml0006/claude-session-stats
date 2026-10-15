import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAR = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100 } as never,
} as const

const run = (args: string) => ({
  command: 'session-stats',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
}) as const

// The world beneath the mod: an in-memory store and clock, a placed pane for
// every open (recorded), no processes (so sampling fails quietly), and the
// engine's own drawing above the prompt.
const world = (on: On) => {
  mock.store(on)
  mock.clock(on)
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('process.run', () => ({ deny: 'no processes in tests' }))
  // Stands in for the engine's own drawing, under the mod's
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">engine</Text>
  })
  return opened
}

test('the bar draws above the prompt and a click on it opens the pane', async ($, on) => {
  const opened = world(on)
  await $.command.run(run('bar on'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-stats', surface, ...BAR })
    expect(await ui.find({ key: 'open-pane' })).toBeDefined()
    await ui.press({ key: 'open-pane' })
    await ui.unmount()
  }
  expect(opened).toEqual(['session-stats', 'session-stats'])
})

test('bar off leaves the space above the prompt to the engine', async ($, on) => {
  world(on)
  await $.command.run(run('bar on'))
  await $.command.run(run('bar off'))
  const ui = await $.ui.mount({ plugin: 'session-stats', surface: 'terminal', ...BAR })
  expect(await ui.find({ key: 'open-pane' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
})

// What 0.1.0 kept in $.state: the host keeps it across a reload or an update
const OLD_STATS = {
  snapshot: {
    rootPid: 800, rootName: 'claude', cores: 10, memBytes: 17179869184, load: [1, 1, 1], cpu: 5, rssKb: 600000,
    procs: [{ pid: 800, ppid: 1, depth: 0, cpu: 5, rssKb: 600000, elapsed: '10:00', name: 'claude' }],
  },
  error: null,
  cpuHistory: [5, 6],
  ramHistory: [600000, 600000],
}

test('the pane still draws from stats an older version kept', async ($, on) => {
  world(on)
  // Beneath the mod, the test answers its read of stats with what 0.1.0 wrote
  on('state.get', { plugin: 'session-stats', key: 'stats' }, () => ({ value: { value: OLD_STATS as never, version: 1 } }))
  const ui = await $.ui.mount({
    plugin: 'session-stats',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-stats',
    props: { bodyColumns: 60 } as never,
  })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('NET ')
  expect(drawn).toContain('claude')
})

test('stop closes the pane, turns the bar off and keeps it off', async ($, on) => {
  const opened = world(on)
  const closed: string[] = []
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  await $.command.run(run('bar on'))
  await $.command.run(run(''))
  expect(opened).toEqual(['session-stats'])

  const result = await $.command.run(run('stop'))
  expect(result.text).toContain('stopped')
  expect(closed).toEqual(['session-stats'])
  const ui = await $.ui.mount({ plugin: 'session-stats', surface: 'terminal', ...BAR })
  expect(await ui.find({ key: 'open-pane' })).toBeUndefined()
})
