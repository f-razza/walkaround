import type {
  AssistantEvent,
  ParsedSession,
  ParseStats,
  SessionEvent,
  ToolCall,
  TokenUsage,
  UserEvent,
} from "./types.js";

/**
 * Event types that never carry metrics. They are counted and skipped.
 * Anything not listed here (and not assistant/user) lands in the
 * unknown bucket instead — the taxonomy drifts across Claude Code
 * versions, so unknown must be a normal outcome, not an error.
 */
const KNOWN_SKIPPED_TYPES = new Set([
  "system",
  "attachment",
  "ai-title",
  "custom-title",
  "last-prompt",
  "mode",
  "permission-mode",
  "queue-operation",
  "file-history-snapshot",
]);

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function baseFields(raw: Record<string, unknown>) {
  return {
    uuid: asString(raw.uuid),
    parentUuid: raw.parentUuid === null ? null : asString(raw.parentUuid),
    sessionId: asString(raw.sessionId),
    timestamp: asString(raw.timestamp),
    cwd: asString(raw.cwd),
    gitBranch: asString(raw.gitBranch),
    version: asString(raw.version),
    isSidechain: typeof raw.isSidechain === "boolean" ? raw.isSidechain : undefined,
  };
}

function extractUsage(message: Record<string, unknown>): TokenUsage | undefined {
  const usage = asRecord(message.usage);
  if (!usage) return undefined;
  return {
    input: asCount(usage.input_tokens),
    output: asCount(usage.output_tokens),
    cacheRead: asCount(usage.cache_read_input_tokens),
    cacheCreation: asCount(usage.cache_creation_input_tokens),
  };
}

function extractToolCalls(message: Record<string, unknown>): ToolCall[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const calls: ToolCall[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (!b || b.type !== "tool_use") continue;
    const name = asString(b.name);
    if (!name) continue;
    calls.push({ id: asString(b.id), name, input: asRecord(b.input) ?? {} });
  }
  return calls;
}

function toAssistantEvent(raw: Record<string, unknown>): AssistantEvent {
  const message = asRecord(raw.message) ?? {};
  return {
    kind: "assistant",
    ...baseFields(raw),
    requestId: asString(raw.requestId),
    messageId: asString(message.id),
    model: asString(message.model),
    usage: extractUsage(message),
    toolCalls: extractToolCalls(message),
    isApiErrorMessage: raw.isApiErrorMessage === true,
    attributionMcpServer: asString(raw.attributionMcpServer),
    attributionMcpTool: asString(raw.attributionMcpTool),
    attributionSkill: asString(raw.attributionSkill),
  };
}

function toUserEvent(raw: Record<string, unknown>): UserEvent {
  const message = asRecord(raw.message) ?? {};
  const content = message.content;

  let resultBlock: Record<string, unknown> | undefined;
  let isError = false;
  let promptText: string | undefined;
  if (typeof content === "string") {
    promptText = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const b = asRecord(block);
      if (!b) continue;
      if (b.type === "tool_result") {
        resultBlock ??= b;
        if (b.is_error === true) isError = true;
      } else if (b.type === "text" && promptText === undefined) {
        promptText = asString(b.text);
      }
    }
  }

  const isToolResult = "toolUseResult" in raw || resultBlock !== undefined;
  return {
    kind: "user",
    ...baseFields(raw),
    isMeta: raw.isMeta === true,
    toolResult: isToolResult
      ? {
          sourceToolAssistantUUID: asString(raw.sourceToolAssistantUUID),
          toolUseId: resultBlock ? asString(resultBlock.tool_use_id) : undefined,
          isError,
        }
      : undefined,
    promptText: isToolResult ? undefined : promptText,
  };
}

type LineOutcome =
  | { kind: "event"; event: SessionEvent }
  | { kind: "skipped-known"; type: string }
  | { kind: "skipped-unknown"; type: string }
  | { kind: "malformed" };

/** Parse a single JSONL line. Never throws. */
export function parseLine(line: string): LineOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: "malformed" };
  }
  const obj = asRecord(raw);
  if (!obj) return { kind: "malformed" };

  const type = asString(obj.type);
  if (type === "assistant") return { kind: "event", event: toAssistantEvent(obj) };
  if (type === "user") return { kind: "event", event: toUserEvent(obj) };
  if (type !== undefined && KNOWN_SKIPPED_TYPES.has(type)) {
    return { kind: "skipped-known", type };
  }
  return { kind: "skipped-unknown", type: type ?? "(missing)" };
}

/** Parse a whole transcript. Blank lines are ignored; nothing ever throws. */
export function parseSession(text: string): ParsedSession {
  const events: SessionEvent[] = [];
  // Null-prototype buckets: type names come straight from the transcript,
  // and keys like "constructor" or "__proto__" must behave as plain counters.
  const stats: ParseStats = {
    totalLines: 0,
    malformedLines: 0,
    skippedKnown: Object.create(null) as Record<string, number>,
    skippedUnknown: Object.create(null) as Record<string, number>,
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    stats.totalLines++;
    const outcome = parseLine(line);
    switch (outcome.kind) {
      case "event":
        events.push(outcome.event);
        break;
      case "skipped-known":
        stats.skippedKnown[outcome.type] = (stats.skippedKnown[outcome.type] ?? 0) + 1;
        break;
      case "skipped-unknown":
        stats.skippedUnknown[outcome.type] = (stats.skippedUnknown[outcome.type] ?? 0) + 1;
        break;
      case "malformed":
        stats.malformedLines++;
        break;
    }
  }
  return { events, stats };
}
