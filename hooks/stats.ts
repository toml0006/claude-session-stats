import type { Proc, Snapshot } from '../types'

// One shell call gathers everything: the spawner's pid (the engine, or a child
// of it), machine facts, then every process. LC_ALL=C keeps ps's decimals dots.
export const PROBE = [
  '/bin/sh',
  '-c',
  'echo $PPID; sysctl -n hw.ncpu hw.memsize vm.loadavg; ps -axo pid=,ppid=,pcpu=,rss=,etime=,comm=',
] as const

const ROW = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/

// "claude bg-spare" and "/Users/x/.local/bin/claude" both name a claude process
const isClaude = (name: string) => name.split(' ')[0]?.split('/').pop() === 'claude'

// A full path may hold spaces ("Application Support"); a renamed title holds words
const shortName = (name: string) => {
  if (name.startsWith('/')) return name.split('/').pop() ?? name
  const [head = '', ...rest] = name.split(' ')
  return [head.split('/').pop(), ...rest].join(' ')
}

export function parseProbe(stdout: string): Snapshot {
  const [spawner = '', ncpu, memsize, loadavg = '', ...rows] = stdout.trim().split('\n')

  const all = new Map<number, Omit<Proc, 'depth'>>()
  for (const row of rows) {
    const m = ROW.exec(row)
    if (!m) continue
    const pid = Number(m[1])
    all.set(pid, {
      pid,
      ppid: Number(m[2]),
      cpu: Number(m[3]),
      rssKb: Number(m[4]),
      elapsed: m[5] ?? '',
      name: (m[6] ?? '').trim(),
    })
  }

  // The session is the nearest claude ancestor of whatever ran the probe
  let rootPid = Number(spawner)
  while (rootPid > 1 && !isClaude(all.get(rootPid)?.name ?? '')) {
    rootPid = all.get(rootPid)?.ppid ?? 1
  }
  if (rootPid <= 1) throw new Error(`no claude process above pid ${spawner}`)

  const children = new Map<number, Omit<Proc, 'depth'>[]>()
  for (const p of all.values()) {
    if (!children.has(p.ppid)) children.set(p.ppid, [])
    children.get(p.ppid)!.push(p)
  }

  // Depth-first so the table reads as a tree; busiest siblings first. The probe's
  // own sh and ps are left out, since they exist only because we asked.
  const probePids = new Set<number>()
  for (const sh of children.get(Number(spawner)) ?? []) {
    const ps = (children.get(sh.pid) ?? []).find(c => shortName(c.name) === 'ps')
    if (shortName(sh.name) === 'sh' && ps) probePids.add(sh.pid).add(ps.pid)
  }
  const procs: Proc[] = []
  const walk = (p: Omit<Proc, 'depth'>, depth: number) => {
    if (probePids.has(p.pid)) return
    procs.push({ ...p, depth, name: shortName(p.name) })
    const kids = [...(children.get(p.pid) ?? [])].sort((a, b) => b.cpu - a.cpu || b.rssKb - a.rssKb)
    for (const k of kids) walk(k, depth + 1)
  }
  walk(all.get(rootPid)!, 0)

  return {
    rootPid,
    rootName: shortName(all.get(rootPid)!.name),
    cores: Number(ncpu),
    memBytes: Number(memsize),
    load: loadavg.replace(/[{}]/g, '').trim().split(/\s+/).map(Number),
    cpu: procs.reduce((s, p) => s + p.cpu, 0),
    rssKb: procs.reduce((s, p) => s + p.rssKb, 0),
    procs,
  }
}

const BARS = '▁▂▃▄▅▆▇█'

export function sparkline(values: readonly number[], max?: number): string {
  const top = max ?? Math.max(1, ...values)
  return values.map(v => BARS[Math.min(7, Math.max(0, Math.round((v / top) * 7)))]).join('')
}

export const gb = (kb: number) => (kb / 1048576).toFixed(kb >= 10485760 ? 0 : 1)
