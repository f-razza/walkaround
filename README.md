# walkaround

> Your AI agent just flew through your codebase. Do the walkaround.

`walkaround` is the post-flight inspection for AI coding sessions. It parses Claude Code's local session transcripts (the JSONL files under `~/.claude/projects/`) and produces a per-session and aggregate report of what the agent actually did: tokens, tool usage, files touched, churn, source-vs-test lines written, errors and retry chains.

Local-only. Read-only. Zero network. Zero runtime dependencies.

## Status

**v0 — work in progress.** Expect rough edges; the report format is not stable yet.

## Honest limits

To be written as the tool stabilizes. In short: these metrics are proxies, not quality judgments.

## License

MIT
