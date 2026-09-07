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
  /**
   * Per-subagent metrics, sorted by output tokens descending. Present only
   * when detail was requested (--subagents); its absence keeps the default
   * text and JSON output unchanged.
   */
  subagents?: SubagentDetail[];
}

/** One subagent transcript's metrics, tied back to its parent session. */
export interface SubagentDetail {
  /** shortId of the session whose transcript spawned this subagent. */
  parentShortId: string;
  metrics: SessionMetrics;
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

function histogramLine(toolCounts: Record<string, number>, top?: number): string {
  let entries = Object.entries(toolCounts).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (entries.length === 0) return "none";
  if (top !== undefined) entries = entries.slice(0, top);
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

/**
 * Transcripts that produced nothing, split by why. An empty `models` list
 * means no assistant turn ever came back, so the request never reached the
 * model: an api error there is the quota wall, its absence a manual stop.
 * Only the third bucket is waste — tokens spent for no output, no call.
 */
export interface SubagentOutcomes {
  rateLimited: number;
  interrupted: number;
  producedNothing: number;
}

export function subagentOutcomes(entries: SubagentDetail[]): SubagentOutcomes {
  const outcomes: SubagentOutcomes = { rateLimited: 0, interrupted: 0, producedNothing: 0 };
  for (const { metrics: m } of entries) {
    if (m.models.length === 0) {
      if (m.errors.apiErrors > 0) outcomes.rateLimited++;
      else outcomes.interrupted++;
    } else if (m.tokens.output === 0 && m.totalToolCalls === 0) {
      outcomes.producedNothing++;
    }
  }
  return outcomes;
}

/** Transcript file name without extension: agent-<id> for real subagents. */
function transcriptName(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  return base.replace(/\.jsonl$/, "");
}

/**
 * One row per subagent transcript plus the same totals line the rollup
 * prints today, so the detail stays reconcilable with --all. Entries are
 * rendered in the order given (the CLI sorts by output tokens descending).
 */
function subagentsSection(entries: SubagentDetail[], rollup: SubagentRollup, repo: string): string {
  if (entries.length === 0) {
    return "subagent detail\n  no subagent transcripts under these sessions";
  }
  const row = (
    cells: [string, string, string, string, string, string, string, string, string, string, string],
  ) =>
    [
      "  ",
      cells[0].padEnd(10),
      cells[1].padEnd(24),
      cells[2].padEnd(28),
      cells[3].padStart(10),
      cells[4].padStart(10),
      cells[5].padStart(7),
      cells[6].padStart(9),
      cells[7].padStart(11),
      cells[8].padStart(7),
      cells[9].padStart(7),
      "  " + cells[10],
    ].join("");
  const out: string[] = [];
  out.push("subagent detail | one row per transcript, sorted by output tokens");
  out.push(
    row([
      "parent",
      "transcript",
      "model",
      "duration",
      "tok out",
      "calls",
      "err t/a",
      "lines s/t",
      "files",
      "retry",
      "top tools | top churn",
    ]),
  );
  for (const { parentShortId, metrics: m } of entries) {
    const churnTop = m.churn[0];
    out.push(
      row([
        parentShortId,
        transcriptName(m.filePath),
        m.models.length > 0 ? m.models.join(", ") : "(none)",
        formatDuration(m.durationMs),
        formatInt(m.tokens.output),
        String(m.totalToolCalls),
        `${m.errors.toolErrors}/${m.errors.apiErrors}`,
        `${formatInt(m.linesWritten.source)}/${formatInt(m.linesWritten.test)}`,
        String(m.filesTouched.length),
        String(m.retryChains.length),
        histogramLine(m.toolCounts, 3) +
          (churnTop !== undefined
            ? ` | ${displayPath(churnTop.filePath, repo)} x${churnTop.edits}`
            : " | no churn"),
      ]),
    );
  }
  out.push(`  total: ${subagentsLine(rollup)}`);
  const outcomes = subagentOutcomes(entries);
  const outcome = (label: string, n: number) => `  ${label.padEnd(38)}${formatInt(n).padStart(7)}`;
  out.push(outcome("never reached the model | rate limit", outcomes.rateLimited));
  out.push(outcome("never reached the model | interrupted", outcomes.interrupted));
  out.push(outcome("reached the model, produced nothing", outcomes.producedNothing));
  return out.join("\n");
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
  if (report.subagents !== undefined) {
    out.push(subagentsSection(report.subagents, agg.subagents, repo));
    out.push("");
  }
  return out.join("\n");
}

/** Same data as the text report, as a stable JSON-serializable object. */
export function reportToJson(report: RepoReport): unknown {
  const { sessions, ...aggregate } = report.aggregate;
  const json: Record<string, unknown> = {
    repo: report.repo,
    claudeCodeVersions: report.aggregate.versionRange ?? null,
    sessions,
    aggregate,
  };
  if (report.subagents !== undefined) json.subagents = report.subagents;
  return json;
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
