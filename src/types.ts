/** Token counters from an assistant message's `usage` block. Raw tokens, no currency. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** A `tool_use` content block extracted from an assistant message. */
export interface ToolCall {
  id?: string;
  name: string;
  input: Record<string, unknown>;
}

interface BaseEvent {
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
}

export interface AssistantEvent extends BaseEvent {
  kind: "assistant";
  /** Dedup key for usage: one API response may span several JSONL lines. */
  requestId?: string;
  messageId?: string;
  model?: string;
  usage?: TokenUsage;
  toolCalls: ToolCall[];
  isApiErrorMessage: boolean;
  attributionMcpServer?: string;
  attributionMcpTool?: string;
  attributionSkill?: string;
}

/** Present on user lines that carry a tool result rather than a human prompt. */
export interface ToolResultInfo {
  sourceToolAssistantUUID?: string;
  toolUseId?: string;
  isError: boolean;
}

export interface UserEvent extends BaseEvent {
  kind: "user";
  isMeta: boolean;
  toolResult?: ToolResultInfo;
  /** First text content of a non-tool-result user line; used to classify human prompts. */
  promptText?: string;
}

export type SessionEvent = AssistantEvent | UserEvent;

export interface ParseStats {
  totalLines: number;
  malformedLines: number;
  /** Recognized non-metric event types, counted and skipped. */
  skippedKnown: Record<string, number>;
  /** Event types we have never seen; counted and skipped, never a crash. */
  skippedUnknown: Record<string, number>;
}

export interface ParsedSession {
  events: SessionEvent[];
  stats: ParseStats;
}
