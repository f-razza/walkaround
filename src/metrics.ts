import {
  isMcpToolName,
  isTestCommand,
  isTestPath,
  mcpServerFromToolName,
  READ_TOOLS,
  WRITE_TOOLS,
  writtenPayload,
} from "./classify.js";
import type {
  AssistantEvent,
  ParsedSession,
  ParseStats,
  TokenUsage,
  UserEvent,
} from "./types.js";

export interface ChurnEntry {
  filePath: string;
  edits: number;
}

export interface RetryChain {
  tool: string;
  filePath?: string;
  length: number;
}

export interface TestRunStats {
  total: number;
  /** Runs whose result came back error-flagged (non-zero exit). */
  failed: number;
}

/** Sums over a session's subagent transcripts, kept apart from the headline numbers. */
export interface SubagentRollup {
  transcripts: number;
  tokens: TokenUsage;
  toolCounts: Record<string, number>;
  totalToolCalls: number;
  reads: number;
  writes: number;
  uniqueFilesTouched: number;
  linesWritten: { source: number; test: number };
  testRuns: TestRunStats;
  errors: { toolErrors: number; apiErrors: number };
  retryChains: number;
  models: string[];
}

export function emptySubagentRollup(): SubagentRollup {
  return {
    transcripts: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    toolCounts: Object.create(null) as Record<string, number>,
    totalToolCalls: 0,
    reads: 0,
    writes: 0,
    uniqueFilesTouched: 0,
    linesWritten: { source: 0, test: 0 },
    testRuns: { total: 0, failed: 0 },
    errors: { toolErrors: 0, apiErrors: 0 },
    retryChains: 0,
    models: [],
  };
}

/**
 * Roll subagent transcripts (each parsed with the same session machinery)
 * into one summary. Prompts and durations are deliberately dropped: a
 * subagent's first user line is its parent's task, not a human prompt.
 */
export function rollupSubagents(subs: SessionMetrics[]): SubagentRollup {
  const rollup = emptySubagentRollup();
  const files = new Set<string>();
  const models = new Set<string>();
  for (const s of subs) {
    rollup.transcripts++;
    rollup.tokens.input += s.tokens.input;
    rollup.tokens.output += s.tokens.output;
    rollup.tokens.cacheRead += s.tokens.cacheRead;
    rollup.tokens.cacheCreation += s.tokens.cacheCreation;
    for (const [name, count] of Object.entries(s.toolCounts)) {
      rollup.toolCounts[name] = (rollup.toolCounts[name] ?? 0) + count;
    }
    rollup.totalToolCalls += s.totalToolCalls;
    rollup.reads += s.reads;
    rollup.writes += s.writes;
    for (const f of s.filesTouched) files.add(f);
    rollup.linesWritten.source += s.linesWritten.source;
    rollup.linesWritten.test += s.linesWritten.test;
    rollup.testRuns.total += s.testRuns.total;
    rollup.testRuns.failed += s.testRuns.failed;
    rollup.errors.toolErrors += s.errors.toolErrors;
    rollup.errors.apiErrors += s.errors.apiErrors;
    rollup.retryChains += s.retryChains.length;
    for (const m of s.models) models.add(m);
  }
  rollup.uniqueFilesTouched = files.size;
  rollup.models = [...models].sort();
  return rollup;
}

function mergeSubagentRollups(rollups: SubagentRollup[]): SubagentRollup {
  const merged = emptySubagentRollup();
  const models = new Set<string>();
  for (const r of rollups) {
    merged.transcripts += r.transcripts;
    merged.tokens.input += r.tokens.input;
    merged.tokens.output += r.tokens.output;
    merged.tokens.cacheRead += r.tokens.cacheRead;
    merged.tokens.cacheCreation += r.tokens.cacheCreation;
    for (const [name, count] of Object.entries(r.toolCounts)) {
      merged.toolCounts[name] = (merged.toolCounts[name] ?? 0) + count;
    }
    merged.totalToolCalls += r.totalToolCalls;
    merged.reads += r.reads;
    merged.writes += r.writes;
    // File lists are not kept per rollup; the merged count is a lower bound
    // when the same file is touched by subagents of different sessions.
    merged.uniqueFilesTouched += r.uniqueFilesTouched;
    merged.linesWritten.source += r.linesWritten.source;
    merged.linesWritten.test += r.linesWritten.test;
    merged.testRuns.total += r.testRuns.total;
    merged.testRuns.failed += r.testRuns.failed;
    merged.errors.toolErrors += r.errors.toolErrors;
    merged.errors.apiErrors += r.errors.apiErrors;
    merged.retryChains += r.retryChains;
    for (const m of r.models) models.add(m);
  }
  merged.models = [...models].sort();
  return merged;
}

export interface SessionMetrics {
  sessionId: string;
  shortId: string;
  filePath: string;
  startTime?: string;
  endTime?: string;
  durationMs: number;
  branches: string[];
  models: string[];
  versionRange?: { min: string; max: string };
  humanPrompts: number;
  tokens: TokenUsage;
  toolCounts: Record<string, number>;
  totalToolCalls: number;
  reads: number;
  writes: number;
  filesTouched: string[];
  churn: ChurnEntry[];
  linesWritten: { source: number; test: number };
  testRuns: TestRunStats;
  errors: { toolErrors: number; apiErrors: number };
  retryChains: RetryChain[];
  sidechain: { events: number; share: number };
  mcp: { calls: number; share: number; servers: string[] };
  subagents: SubagentRollup;
  parse: ParseStats;
}

export interface AggregateMetrics {
  sessionCount: number;
  totalDurationMs: number;
  humanPrompts: number;
  tokens: TokenUsage;
  toolCounts: Record<string, number>;
  totalToolCalls: number;
  reads: number;
  writes: number;
  uniqueFilesTouched: number;
  topChurn: ChurnEntry[];
  linesWritten: { source: number; test: number };
  testRuns: TestRunStats;
  errors: { toolErrors: number; apiErrors: number };
  retryChains: number;
  mcpCalls: number;
  sidechainEvents: number;
  subagents: SubagentRollup;
  versionRange?: { min: string; max: string };
  /** Per-session metrics sorted by start time ascending. */
  sessions: SessionMetrics[];
}

/** Numeric-segment version compare; falls back to string compare on ties. */
function compareVersions(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const an = Number.parseInt(as[i] ?? "0", 10);
    const bn = Number.parseInt(bs[i] ?? "0", 10);
    if (Number.isNaN(an) || Number.isNaN(bn)) break;
    if (an !== bn) return an - bn;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function versionRangeOf(versions: Iterable<string>): { min: string; max: string } | undefined {
  let min: string | undefined;
  let max: string | undefined;
  for (const v of versions) {
    if (min === undefined || compareVersions(v, min) < 0) min = v;
    if (max === undefined || compareVersions(v, max) > 0) max = v;
  }
  return min !== undefined && max !== undefined ? { min, max } : undefined;
}

function sortChurn(counts: Map<string, number>): ChurnEntry[] {
  return [...counts.entries()]
    .map(([filePath, edits]) => ({ filePath, edits }))
    .sort((a, b) => b.edits - a.edits || a.filePath.localeCompare(b.filePath));
}

/** A non-result, non-meta, non-sidechain user line whose text is not a harness tag. */
function isHumanPrompt(event: UserEvent): boolean {
  if (event.toolResult || event.isMeta || event.isSidechain === true) return false;
  return !(event.promptText?.trimStart().startsWith("<") ?? false);
}

/** The tool call a result line answers, resolved via sourceToolAssistantUUID. */
function resolveResultCall(
  event: UserEvent,
  assistantByUuid: Map<string, AssistantEvent>,
): { tool?: string; filePath?: string } {
  const result = event.toolResult;
  if (!result) return {};
  const source =
    result.sourceToolAssistantUUID !== undefined
      ? assistantByUuid.get(result.sourceToolAssistantUUID)
      : undefined;
  let call = source?.toolCalls.find((c) => c.id !== undefined && c.id === result.toolUseId);
  if (call === undefined && source !== undefined && source.toolCalls.length === 1) {
    call = source.toolCalls[0];
  }
  if (call === undefined) return {};
  return {
    tool: call.name,
    filePath: typeof call.input.file_path === "string" ? call.input.file_path : undefined,
  };
}

export function computeSessionMetrics(
  parsed: ParsedSession,
  filePath: string,
  subagentMetrics: SessionMetrics[] = [],
): SessionMetrics {
  const { events, stats } = parsed;

  let sessionId: string | undefined;
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  let startTime: string | undefined;
  let endTime: string | undefined;
  const branches: string[] = [];
  const models: string[] = [];
  const versions = new Set<string>();
  const seen = { branch: new Set<string>(), model: new Set<string>() };

  // One API response may span several JSONL lines, each repeating usage with
  // output_tokens growing as blocks stream in: dedup by request, last line wins.
  const usageByRequest = new Map<string, TokenUsage>();
  let lineIndex = 0;

  // Null-prototype: tool names come straight from the transcript, and keys
  // like "constructor" or "__proto__" must behave as plain counters.
  const toolCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  let totalToolCalls = 0;
  let reads = 0;
  let writes = 0;
  const filesTouched: string[] = [];
  const touchedSeen = new Set<string>();
  const churnCounts = new Map<string, number>();
  let mcpCalls = 0;
  const mcpServers = new Set<string>();
  let apiErrors = 0;
  let toolErrors = 0;
  let humanPrompts = 0;
  let sidechainTrue = 0;
  let sidechainFlagged = 0;

  const assistantByUuid = new Map<string, AssistantEvent>();
  interface PendingWrite {
    filePath?: string;
    lines: number;
    failed: boolean;
  }
  const writesByToolUseId = new Map<string, PendingWrite>();
  const unkeyedWrites: PendingWrite[] = [];
  const testRuns: TestRunStats = { total: 0, failed: 0 };
  const testRunToolUseIds = new Set<string>();
  const orderedResults: Array<{ tool?: string; filePath?: string; isError: boolean }> = [];

  for (const event of events) {
    lineIndex++;
    sessionId ??= event.sessionId;
    if (event.timestamp !== undefined) {
      const ms = Date.parse(event.timestamp);
      if (!Number.isNaN(ms)) {
        if (ms < startMs) {
          startMs = ms;
          startTime = event.timestamp;
        }
        if (ms > endMs) {
          endMs = ms;
          endTime = event.timestamp;
        }
      }
    }
    if (event.gitBranch !== undefined && !seen.branch.has(event.gitBranch)) {
      seen.branch.add(event.gitBranch);
      branches.push(event.gitBranch);
    }
    if (event.version !== undefined) versions.add(event.version);
    if (event.isSidechain === true) {
      sidechainTrue++;
      sidechainFlagged++;
    } else if (event.isSidechain === false) {
      sidechainFlagged++;
    }

    if (event.kind === "assistant") {
      if (event.uuid !== undefined) assistantByUuid.set(event.uuid, event);
      if (event.isApiErrorMessage) apiErrors++;
      if (
        event.model !== undefined &&
        event.model !== "<synthetic>" &&
        !seen.model.has(event.model)
      ) {
        seen.model.add(event.model);
        models.push(event.model);
      }
      if (event.usage) {
        const key = event.requestId ?? event.messageId ?? event.uuid ?? `line-${lineIndex}`;
        usageByRequest.set(key, event.usage);
      }
      const lineIsMcp =
        event.attributionMcpServer !== undefined || event.attributionMcpTool !== undefined;
      if (event.attributionMcpServer !== undefined) mcpServers.add(event.attributionMcpServer);
      for (const call of event.toolCalls) {
        totalToolCalls++;
        toolCounts[call.name] = (toolCounts[call.name] ?? 0) + 1;
        if (READ_TOOLS.has(call.name)) reads++;
        if (WRITE_TOOLS.has(call.name)) writes++;
        if (isMcpToolName(call.name) || lineIsMcp) {
          mcpCalls++;
          const server = mcpServerFromToolName(call.name);
          if (server !== undefined) mcpServers.add(server);
        }
        if (
          typeof call.input.file_path === "string" &&
          (READ_TOOLS.has(call.name) || WRITE_TOOLS.has(call.name))
        ) {
          if (!touchedSeen.has(call.input.file_path)) {
            touchedSeen.add(call.input.file_path);
            filesTouched.push(call.input.file_path);
          }
        }
        if (WRITE_TOOLS.has(call.name)) {
          const payload = writtenPayload(call);
          if (payload.filePath !== undefined) {
            churnCounts.set(payload.filePath, (churnCounts.get(payload.filePath) ?? 0) + 1);
          }
          const pending: PendingWrite = { ...payload, failed: false };
          if (call.id !== undefined) writesByToolUseId.set(call.id, pending);
          else unkeyedWrites.push(pending);
        }
        if (call.name === "Bash" && typeof call.input.command === "string") {
          if (isTestCommand(call.input.command)) {
            testRuns.total++;
            if (call.id !== undefined) testRunToolUseIds.add(call.id);
          }
        }
      }
    } else {
      if (event.toolResult) {
        if (event.toolResult.isError) {
          toolErrors++;
          const { toolUseId } = event.toolResult;
          if (toolUseId !== undefined) {
            const pending = writesByToolUseId.get(toolUseId);
            if (pending) pending.failed = true;
            if (testRunToolUseIds.has(toolUseId)) testRuns.failed++;
          }
        }
        orderedResults.push({
          ...resolveResultCall(event, assistantByUuid),
          isError: event.toolResult.isError,
        });
      } else if (isHumanPrompt(event)) {
        humanPrompts++;
      }
    }
  }

  const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  for (const usage of usageByRequest.values()) {
    tokens.input += usage.input;
    tokens.output += usage.output;
    tokens.cacheRead += usage.cacheRead;
    tokens.cacheCreation += usage.cacheCreation;
  }

  // Lines written counts only writes whose result did not come back as an
  // error; a write with no result at all (interrupted session) still counts.
  const linesWritten = { source: 0, test: 0 };
  for (const pending of [...writesByToolUseId.values(), ...unkeyedWrites]) {
    if (pending.failed) continue;
    if (pending.filePath !== undefined && isTestPath(pending.filePath)) {
      linesWritten.test += pending.lines;
    } else {
      linesWritten.source += pending.lines;
    }
  }

  // A retry chain is a maximal run of >= 2 consecutive failed results for
  // the same tool and file; any success or change of target breaks the run.
  // Failures whose source call cannot be resolved never form chains: two
  // unattributable failures are not evidence of retrying the same thing.
  const retryChains: RetryChain[] = [];
  let run: { tool: string; filePath?: string; length: number } | undefined;
  const closeRun = () => {
    if (run !== undefined && run.length >= 2) {
      retryChains.push({ tool: run.tool, filePath: run.filePath, length: run.length });
    }
    run = undefined;
  };
  for (const result of orderedResults) {
    if (!result.isError || result.tool === undefined) {
      closeRun();
    } else if (run !== undefined && run.tool === result.tool && run.filePath === result.filePath) {
      run.length++;
    } else {
      closeRun();
      run = { tool: result.tool, filePath: result.filePath, length: 1 };
    }
  }
  closeRun();

  const durationMs =
    startMs !== Number.POSITIVE_INFINITY && endMs !== Number.NEGATIVE_INFINITY
      ? endMs - startMs
      : 0;

  return {
    sessionId: sessionId ?? "(unknown)",
    shortId: (sessionId ?? "(unknown)").slice(0, 8),
    filePath,
    startTime,
    endTime,
    durationMs,
    branches,
    models,
    versionRange: versionRangeOf(versions),
    humanPrompts,
    tokens,
    toolCounts,
    totalToolCalls,
    reads,
    writes,
    filesTouched,
    churn: sortChurn(churnCounts),
    linesWritten,
    testRuns,
    errors: { toolErrors, apiErrors },
    retryChains,
    sidechain: {
      events: sidechainTrue,
      share: sidechainFlagged === 0 ? 0 : sidechainTrue / sidechainFlagged,
    },
    mcp: {
      calls: mcpCalls,
      share: totalToolCalls === 0 ? 0 : mcpCalls / totalToolCalls,
      servers: [...mcpServers].sort(),
    },
    subagents: rollupSubagents(subagentMetrics),
    parse: stats,
  };
}

export function aggregateMetrics(sessions: SessionMetrics[]): AggregateMetrics {
  const sorted = [...sessions].sort((a, b) => {
    const am = a.startTime !== undefined ? Date.parse(a.startTime) : Number.POSITIVE_INFINITY;
    const bm = b.startTime !== undefined ? Date.parse(b.startTime) : Number.POSITIVE_INFINITY;
    return am - bm || a.sessionId.localeCompare(b.sessionId);
  });

  const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const toolCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  const churnCounts = new Map<string, number>();
  const touched = new Set<string>();
  const versions: string[] = [];
  const agg: AggregateMetrics = {
    sessionCount: sorted.length,
    totalDurationMs: 0,
    humanPrompts: 0,
    tokens,
    toolCounts,
    totalToolCalls: 0,
    reads: 0,
    writes: 0,
    uniqueFilesTouched: 0,
    topChurn: [],
    linesWritten: { source: 0, test: 0 },
    testRuns: { total: 0, failed: 0 },
    errors: { toolErrors: 0, apiErrors: 0 },
    retryChains: 0,
    mcpCalls: 0,
    sidechainEvents: 0,
    subagents: emptySubagentRollup(),
    sessions: sorted,
  };

  for (const s of sorted) {
    agg.totalDurationMs += s.durationMs;
    agg.humanPrompts += s.humanPrompts;
    tokens.input += s.tokens.input;
    tokens.output += s.tokens.output;
    tokens.cacheRead += s.tokens.cacheRead;
    tokens.cacheCreation += s.tokens.cacheCreation;
    for (const [name, count] of Object.entries(s.toolCounts)) {
      toolCounts[name] = (toolCounts[name] ?? 0) + count;
    }
    agg.totalToolCalls += s.totalToolCalls;
    agg.reads += s.reads;
    agg.writes += s.writes;
    for (const f of s.filesTouched) touched.add(f);
    for (const entry of s.churn) {
      churnCounts.set(entry.filePath, (churnCounts.get(entry.filePath) ?? 0) + entry.edits);
    }
    agg.linesWritten.source += s.linesWritten.source;
    agg.linesWritten.test += s.linesWritten.test;
    agg.testRuns.total += s.testRuns.total;
    agg.testRuns.failed += s.testRuns.failed;
    agg.errors.toolErrors += s.errors.toolErrors;
    agg.errors.apiErrors += s.errors.apiErrors;
    agg.retryChains += s.retryChains.length;
    agg.mcpCalls += s.mcp.calls;
    agg.sidechainEvents += s.sidechain.events;
    if (s.versionRange) versions.push(s.versionRange.min, s.versionRange.max);
  }

  agg.uniqueFilesTouched = touched.size;
  agg.topChurn = sortChurn(churnCounts).slice(0, 10);
  agg.versionRange = versionRangeOf(versions);
  agg.subagents = mergeSubagentRollups(sorted.map((s) => s.subagents));
  return agg;
}
