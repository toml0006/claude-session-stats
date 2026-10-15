import { expect, test } from 'claude-code/testing'

import { parseProbe, sparkline } from './stats'

// 900 is the engine-side spawner; 950/951 are the probe's own sh and ps.
const PROBE_OUT = `900
10
17179869184
{ 1.50 2.00 2.50 }
    1     0   0.0   1000 10-00:00:00 /sbin/launchd
  100     1   0.0   5000 01:00:00 /Users/x/.local/bin/claude
  800   100  12.5 600000 30:00 claude bg-spare
  900   800   1.0  40000 29:00 claude
  810   800  50.0 200000 05:00 /opt/homebrew/bin/node
  811   810   0.5  10000 04:00 /bin/zsh
  950   900   0.0    800 00:00 /bin/sh
  951   950   0.0    900 00:00 ps
  999     1  99.0 900000 10:00 /Applications/Other.app/Other
`

test('sums the nearest claude ancestor and its descendants only', () => {
  const s = parseProbe(PROBE_OUT)
  expect(s.rootPid).toBe(900)
  expect(s.procs.map(p => p.pid)).toEqual([900])
})

test('a renamed background session process counts as claude', () => {
  const s = parseProbe(PROBE_OUT.replace(/^900\n/, '811\n'))
  expect(s.rootPid).toBe(800)
  expect(s.rootName).toBe('claude bg-spare')
  expect(s.procs.map(p => [p.pid, p.depth])).toEqual([[800, 0], [810, 1], [811, 2], [900, 1], [950, 2], [951, 3]])
  expect(s.cpu).toBe(64)
  expect(s.cores).toBe(10)
  expect(s.load).toEqual([1.5, 2, 2.5])
})

test('leaves out the probe sh and ps under the spawner', () => {
  const s = parseProbe(PROBE_OUT.replace(/^900\n/, '810\n').replace('  950   900', '  950   810'))
  expect(s.rootPid).toBe(800)
  expect(s.procs.map(p => p.pid)).toEqual([800, 810, 811, 900])
})

test('sparkline scales to the max', () => {
  expect(sparkline([0, 50, 100])).toBe('▁▅█')
})
