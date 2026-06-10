import type {
  AggregateMetrics,
  SessionMetrics,
  SubagentRollup,
  TestRunStats,
} from "./metrics.js";

export interface RepoReport {
  /** Repo path the sessions were matched against, or "(unknown)". */
  repo: string;
  aggregate: AggregateMetrics;
}

function formatInt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} h ${String(minutes).padStart(2, "0")} min`;
}

function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function plural(n: number, word: string): string {
  return `${formatInt(n)} ${word}${n === 1 ? "" : "s"}`;
}

function formatWhen(iso: string | undefined): string {
  if (iso === undefined) return "(no timestamp)";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "(no timestamp)";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Show paths relative to the repo when they live under it. */
function displayPath(filePath: string, repo: string): string {
  if (repo !== "(unknown)" && filePath.startsWith(repo + "/")) {
    return filePath.slice(repo.length + 1);
  }
  return filePath;
}

function histogramLine(toolCounts: Record<string, number>): string {
  const entries = Object.entries(toolCounts).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (entries.length === 0) return "none";
  return entries.map(([name, count]) => `${name} x${count}`).join(", ");
}

function churnLine(entries: Array<{ filePath: string; edits: number }>, repo: string, top: number): string {
  if (entries.length === 0) return "none";
  return entries
    .slice(0, top)
    .map((e) => `${displayPath(e.filePath, repo)} x${e.edits}`)
    .join(", ");
}

function testRunsLine(t: TestRunStats): string {
  if (t.total === 0) return "0";
  return t.failed > 0 ? `${t.total} (${t.failed} failed)` : `${t.total}, none failed`;
}

function subagentsLine(sub: SubagentRollup): string {
  if (sub.transcripts === 0) return "none";
  return [
    plural(sub.transcripts, "transcript"),
    `in ${formatInt(sub.tokens.input)}`,
    `out ${formatInt(sub.tokens.output)}`,
    plural(sub.totalToolCalls, "call"),
    plural(sub.errors.toolErrors + sub.errors.apiErrors, "error"),
  ].join(" | ");
}

function skippedSummary(s: SessionMetrics): string {
  const known = Object.values(s.parse.skippedKnown).reduce((a, b) => a + b, 0);
  const unknownEntries = Object.entries(s.parse.skippedUnknown);
  const unknown = unknownEntries.reduce((a, [, n]) => a + n, 0);
  let line = `${known} known, ${unknown} unknown, ${s.parse.malformedLines} malformed`;
  if (unknown > 0) {
    line += ` (unknown types: ${unknownEntries.map(([t, n]) => `${t} x${n}`).join(", ")})`;
  }
  return line;
}

function sessionBlock(s: SessionMetrics, repo: string): string {
  const header = [
    `session ${s.shortId}`,
    formatWhen(s.startTime),
    formatDuration(s.durationMs),
    s.branches.length > 0 ? `branch ${s.branches.join(", ")}` : "no branch",
    s.models.length > 0 ? s.models.join(", ") : "no model recorded",
  ].join(" | ");

  const lines = [
    header,
    `  prompts        ${s.humanPrompts} human`,
    `  tokens         in ${formatInt(s.tokens.input)} | out ${formatInt(s.tokens.output)} | cache read ${formatInt(s.tokens.cacheRead)} | cache write ${formatInt(s.tokens.cacheCreation)}`,
    `  tools          ${plural(s.totalToolCalls, "call")}: ${histogramLine(s.toolCounts)}`,
    `  reads/writes   ${plural(s.reads, "read")} vs ${plural(s.writes, "write")}`,
    `  files touched  ${s.filesTouched.length}`,
    `  top churn      ${churnLine(s.churn, repo, 3)}`,
    `  lines written  ${formatInt(s.linesWritten.source)} source / ${formatInt(s.linesWritten.test)} test`,
    `  test runs      ${testRunsLine(s.testRuns)}`,
    `  errors         ${s.errors.toolErrors} tool, ${s.errors.apiErrors} api | retry chains: ${s.retryChains.length}`,
    `  sidechain      ${formatShare(s.sidechain.share)} of events | mcp: ${plural(s.mcp.calls, "call")}${
      s.mcp.servers.length > 0 ? ` (${s.mcp.servers.join(", ")})` : ""
    }`,
    `  subagents      ${subagentsLine(s.subagents)}`,
    `  skipped        ${skippedSummary(s)}`,
  ];
  return lines.join("\n");
}

function sessionsTable(sessions: SessionMetrics[]): string {
  const row = (cells: [string, string, string, string, string, string, string]) =>
    [
      "  ",
      cells[0].padEnd(12),
      cells[1].padEnd(10),
      cells[2].padStart(12),
      cells[3].padStart(9),
      cells[4].padStart(12),
      cells[5].padStart(12),
      cells[6].padStart(8),
    ].join("");
  const header = row(["date", "id", "duration", "prompts", "tokens out", "tool calls", "errors"]);
  const rows = sessions.map((s) =>
    row([
      s.startTime !== undefined ? s.startTime.slice(0, 10) : "(unknown)",
      s.shortId,
      formatDuration(s.durationMs),
      String(s.humanPrompts),
      formatInt(s.tokens.output),
      String(s.totalToolCalls),
      String(s.errors.toolErrors + s.errors.apiErrors),
    ]),
  );
  return [header, ...rows].join("\n");
}

export function renderText(report: RepoReport): string {
  const { repo, aggregate: agg } = report;
  const out: string[] = [];
  out.push("walkaround | post-flight inspection");
  out.push(`repo: ${repo}`);
  out.push(
    `sessions: ${agg.sessionCount}` +
      (agg.versionRange !== undefined
        ? ` | Claude Code versions observed: ${
            agg.versionRange.min === agg.versionRange.max
              ? agg.versionRange.min
              : `${agg.versionRange.min} - ${agg.versionRange.max}`
          }`
        : " | Claude Code version: not recorded"),
  );
  out.push("");

  for (const s of agg.sessions) {
    out.push(sessionBlock(s, repo));
    out.push("");
  }

  const ratio =
    agg.linesWritten.test === 0
      ? agg.linesWritten.source === 0
        ? "nothing written"
        : "all source, no test lines"
      : `${(agg.linesWritten.source / agg.linesWritten.test).toFixed(1)}:1 source:test`;

  out.push(
    `aggregate | ${agg.sessionCount} session${agg.sessionCount === 1 ? "" : "s"} | total agent time ${formatDuration(agg.totalDurationMs)}`,
  );
  out.push(`  prompts        ${agg.humanPrompts} human`);
  out.push(
    `  tokens         in ${formatInt(agg.tokens.input)} | out ${formatInt(agg.tokens.output)} | cache read ${formatInt(agg.tokens.cacheRead)} | cache write ${formatInt(agg.tokens.cacheCreation)}`,
  );
  out.push(`  tools          ${plural(agg.totalToolCalls, "call")}: ${histogramLine(agg.toolCounts)}`);
  out.push(`  reads/writes   ${plural(agg.reads, "read")} vs ${plural(agg.writes, "write")}`);
  out.push(`  files touched  ${agg.uniqueFilesTouched} unique`);
  out.push(
    `  lines written  ${formatInt(agg.linesWritten.source)} source / ${formatInt(agg.linesWritten.test)} test (${ratio})`,
  );
  out.push(`  test runs      ${testRunsLine(agg.testRuns)}`);
  out.push(
    `  errors         ${agg.errors.toolErrors} tool, ${agg.errors.apiErrors} api | retry chains: ${agg.retryChains}`,
  );
  out.push(`  mcp calls      ${agg.mcpCalls} | sidechain events: ${agg.sidechainEvents}`);
  out.push(`  subagents      ${subagentsLine(agg.subagents)}`);
  out.push(`  top churn      ${churnLine(agg.topChurn, repo, 10)}`);
  out.push("");
  out.push(sessionsTable(agg.sessions));
  out.push("");
  return out.join("\n");
}

/** Same data as the text report, as a stable JSON-serializable object. */
export function reportToJson(report: RepoReport): unknown {
  const { sessions, ...aggregate } = report.aggregate;
  return {
    repo: report.repo,
    claudeCodeVersions: report.aggregate.versionRange ?? null,
    sessions,
    aggregate,
  };
}

/** One session reduced to derived indicators, for cross-session comparison. */
export interface TrendRow {
  date: string;
  shortId: string;
  durationMs: number;
  prompts: number;
  tokensOut: number;
  /** Output tokens bought by one human prompt; null when no prompts. */
  outPerPrompt: number | null;
  /** Failed calls per 100 tool calls; null when no calls. */
  errPer100Calls: number | null;
  testRuns: TestRunStats;
  reads: number;
  writes: number;
  subagentTranscripts: number;
  /** Most-edited file as "basename xN", or null when nothing was written. */
  topChurn: string | null;
}

export function trendRows(agg: AggregateMetrics): TrendRow[] {
  return agg.sessions.map((s) => {
    const errors = s.errors.toolErrors + s.errors.apiErrors;
    const top = s.churn[0];
    return {
      date: s.startTime !== undefined ? s.startTime.slice(0, 10) : "(unknown)",
      shortId: s.shortId,
      durationMs: s.durationMs,
      prompts: s.humanPrompts,
      tokensOut: s.tokens.output,
      outPerPrompt: s.humanPrompts > 0 ? Math.round(s.tokens.output / s.humanPrompts) : null,
      errPer100Calls:
        s.totalToolCalls > 0 ? Math.round((1000 * errors) / s.totalToolCalls) / 10 : null,
      testRuns: s.testRuns,
      reads: s.reads,
      writes: s.writes,
      subagentTranscripts: s.subagents.transcripts,
      topChurn: top !== undefined ? `${top.filePath.split("/").pop()} x${top.edits}` : null,
    };
  });
}

export function renderTrend(report: RepoReport): string {
  const { repo, aggregate: agg } = report;
  const row = (cells: [string, string, string, string, string, string, string, string, string, string]) =>
    [
      "  ",
      cells[0].padEnd(12),
      cells[1].padEnd(10),
      cells[2].padStart(12),
      cells[3].padStart(9),
      cells[4].padStart(12),
      cells[5].padStart(9),
      cells[6].padStart(8),
      cells[7].padStart(7),
      cells[8].padStart(7),
      "  " + cells[9],
    ].join("");

  const out: string[] = [];
  out.push("walkaround | trend");
  out.push(`repo: ${repo}`);
  out.push(
    `sessions: ${agg.sessionCount}` +
      (agg.versionRange !== undefined
        ? ` | Claude Code versions observed: ${
            agg.versionRange.min === agg.versionRange.max
              ? agg.versionRange.min
              : `${agg.versionRange.min} - ${agg.versionRange.max}`
          }`
        : " | Claude Code version: not recorded"),
  );
  out.push("");
  out.push(
    row(["date", "id", "duration", "prompts", "out/prompt", "err/100", "tests", "r/w", "subag", "top churn"]),
  );
  for (const r of trendRows(agg)) {
    out.push(
      row([
        r.date,
        r.shortId,
        formatDuration(r.durationMs),
        String(r.prompts),
        r.outPerPrompt !== null ? formatInt(r.outPerPrompt) : "-",
        r.errPer100Calls !== null ? r.errPer100Calls.toFixed(1) : "-",
        `${r.testRuns.total}${r.testRuns.failed > 0 ? `(${r.testRuns.failed}F)` : ""}`,
        `${r.reads}/${r.writes}`,
        String(r.subagentTranscripts),
        r.topChurn ?? "-",
      ]),
    );
  }
  out.push("");
  out.push(
    "  out/prompt: output tokens bought by one human prompt | err/100: failed calls per 100 tool calls",
  );
  out.push("  tests: runs (F = failed runs) | r/w: read vs write calls | subag: subagent transcripts");
  out.push("");
  return out.join("\n");
}

/** Same data as the trend table, as a stable JSON-serializable object. */
export function trendToJson(report: RepoReport): unknown {
  return {
    repo: report.repo,
    claudeCodeVersions: report.aggregate.versionRange ?? null,
    rows: trendRows(report.aggregate),
  };
}
