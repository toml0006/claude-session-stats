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
