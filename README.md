# walkaround

> Your AI agent just flew through your codebase. Do the walkaround.

`walkaround` is the post-flight inspection for AI coding sessions. It parses Claude Code's local session transcripts (the JSONL files under `~/.claude/projects/`) and produces a per-session and aggregate report of what the agent actually did: tokens, tool usage, files touched, churn, source-vs-test lines written, errors and retry chains.

Local-only. Read-only. Zero network. Zero runtime dependencies.

## Status

**v0 — work in progress.** The report format is not stable yet.

## Install

```sh
npm install -g walkaround
# or run it without installing:
npx walkaround
```

Requires Node >= 20.

## Usage

```sh
walkaround            # report for the repo you are in
walkaround ~/dev/app  # report for another repo
walkaround --all      # every project Claude Code has touched
walkaround --json     # same data, machine-readable
```

Sessions are matched to a repo by the `cwd` recorded *inside* each transcript, not by folder name — folder names under `~/.claude/projects` are lossy encodings and lie about paths containing dashes.

## What it measures

Per session, and aggregated across sessions:

| Metric | What it actually is |
| --- | --- |
| prompts | User-typed messages: `user` lines that are not tool results, not meta lines, not sidechain traffic, and don't start with a harness tag like `<local-command-stdout>` |
| tokens | Raw token counters from the API usage blocks: input, output, cache read, cache write. One API response spans several JSONL lines repeating its usage; walkaround dedups by request id and keeps the last (largest) value |
| tools | Histogram of `tool_use` calls by tool name |
| reads/writes | Read + Grep + Glob calls vs Edit + Write + MultiEdit calls |
| files touched | Unique `file_path` values across read and write tools |
| top churn | Files with the most write attempts — failed attempts count, because hammering a file is signal |
| lines written | Line count of write payloads that did **not** come back as an error, split source vs test by path (`*.test.*`, `*.spec.*`, `__tests__/`, `tests/`, `test/`) |
| test runs | Bash commands invoking `npm test`, `vitest`, `jest`, `pytest`, `go test` or `cargo test`; a run counts as failed when its result comes back error-flagged (non-zero exit) |
| errors | Tool results flagged `is_error` plus API-error assistant lines |
| retry chains | Runs of >= 2 consecutive failed results for the same tool on the same file |
| sidechain | Share of events flagged as sidechain (subagent) traffic |
| mcp | Tool calls routed to MCP servers (`mcp__` name prefix or MCP attribution fields) |
| subagents | Rollup of the session's subagent transcripts (`<session>/subagents/`, recursively): transcript count, tokens, tool calls, files, lines written, test runs, errors. Kept apart from the headline numbers so the main transcript stays comparable across sessions |
| skipped | Non-metric event lines, counted by type; unknown types and malformed lines are counted too, never a crash |

The report header states the Claude Code version range observed in the data, because the transcript schema drifts across versions.

## Honest limits

These numbers are **proxies, not quality judgments**. A high churn count can be healthy iteration; a perfect-looking session can ship the wrong feature.

- **Token counts are floor estimates.** Some lines carry no usage. Subagent work is parsed and reported in the per-session `subagents` rollup, but it is not folded into the headline token numbers — add the two if you want total cost.
- **Test run outcomes are exit statuses, not test counts.** A "failed" run means the command exited non-zero; walkaround does not parse runner output, so it cannot tell 1 failing test from 100.
- **Duration is the wall-clock span** between the first and last timestamped event. A session resumed across days reports as days, not active time.
- **Path heuristics are imperfect.** `src/contest.ts` is source, but a test helper outside the known test patterns counts as source too. Reads performed through shell commands (`grep` inside Bash) don't count as reads.
- **Lines written counts payloads, not net diff.** A 100-line Write over a 99-line file counts 100 lines, and nothing is subtracted when the agent deletes code.
- **Prompt counting is heuristic.** Queued messages, slash-command wrappers and pasted command output are filtered by shape, not by ground truth.
- **Schema knowledge is empirical.** The format was observed on Claude Code versions 2.1.76 - 2.1.170 (notably: one API response spans multiple JSONL lines repeating `message.id` and `usage`, so naive summing would overcount tokens up to ~50x). Other versions are parsed defensively: unknown event types are counted and skipped.
- **Claude Code only** for now. No other agent formats.

## Development

```sh
npm install
npm test        # vitest, fixtures are fully synthetic
npm run build   # tsup -> dist/
```

The repo contains no real transcript data; every fixture is hand-crafted. Real transcripts under `~/.claude/projects` are read-only runtime input.

## License

MIT
