# session-stats

A Claude Code mod that shows what your current session is costing your machine.
Type `/session-stats` and a pane opens with:

- CPU and RAM for the session's whole process tree (the `claude` process plus every
  shell, build, test runner and stdio MCP server it started), with sparklines of up to the last 4 minutes
- the session's share of your cores and memory, process count, uptime and load average
- a process table, indented as a tree, busiest first

It samples every 2 seconds while the pane or the bar is showing, and stops when neither is.

### Bar mode

`/session-stats bar` toggles a one-line strip above the prompt:

```
⚙ CPU  12% ▁▂▂▃▅▃▂▁··········  RAM  0.8G ▃▃▃▄▄▅▅▅··········
```

Each history is up to 30 cells wide (one minute) from the start and fills left to
right, then scrolls. Click the strip to open the full pane. The setting is remembered across sessions;
`/session-stats bar on` and `/session-stats bar off` set it directly.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-stats --marketplace toml0006/claude-session-stats
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install session-stats --marketplace toml0006/claude-session-stats
```

## Limits

- **macOS only.** It reads `sysctl hw.memsize` and `vm.loadavg` and macOS `ps` output.
- Subagents run inside the main `claude` process, so they're part of its numbers,
  not separate rows.
- MCP servers reached over HTTP run outside the session and aren't counted.
- CPU % is `ps`'s smoothed recent average and can pass 100% on multiple cores.
- RAM sums each process's resident memory, so shared pages count more than once.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
