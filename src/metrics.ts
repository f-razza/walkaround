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
  testRuns: number;
  errors: { toolErrors: number; apiErrors: number };
  retryChains: RetryChain[];
  sidechain: { events: number; share: number };
  mcp: { calls: number; share: number; servers: string[] };
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
  testRuns: number;
  errors: { toolErrors: number; apiErrors: number };
  retryChains: number;
  mcpCalls: number;
  sidechainEvents: number;
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

export function computeSessionMetrics(parsed: ParsedSession, filePath: string): SessionMetrics {
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

  const toolCounts: Record<string, number> = {};
  let totalToolCalls = 0;
  let reads = 0;
  let writes = 0;
  const filesTouched: string[] = [];
  const touchedSeen = new Set<string>();
  const churnCounts = new Map<string, number>();
  let mcpCalls = 0;
  const mcpServers = new Set<string>();
  let testRuns = 0;
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
          if (isTestCommand(call.input.command)) testRuns++;
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
  const retryChains: RetryChain[] = [];
  let run: { tool?: string; filePath?: string; length: number } | undefined;
  const closeRun = () => {
    if (run !== undefined && run.length >= 2) {
      retryChains.push({ tool: run.tool ?? "(unknown)", filePath: run.filePath, length: run.length });
    }
    run = undefined;
  };
  for (const result of orderedResults) {
    if (!result.isError) {
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
  const toolCounts: Record<string, number> = {};
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
    testRuns: 0,
    errors: { toolErrors: 0, apiErrors: 0 },
    retryChains: 0,
    mcpCalls: 0,
    sidechainEvents: 0,
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
    agg.testRuns += s.testRuns;
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
  return agg;
}
