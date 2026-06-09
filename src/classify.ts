import type { ToolCall } from "./types.js";

/** Tools that inspect the codebase without changing it. */
export const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

/** Tools that write file content. */
export const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

const TEST_DIR_SEGMENT = /(^|\/)(__tests__|tests?)(\/)/;
const TEST_BASENAME = /\.(test|spec)\.[^/]+$/;

/** Path heuristic for "this is test code". Imperfect by design; see README. */
export function isTestPath(filePath: string): boolean {
  return TEST_DIR_SEGMENT.test(filePath) || TEST_BASENAME.test(filePath);
}

const TEST_COMMAND =
  /(?<![\w-])(npm\s+test|vitest|jest|pytest|go\s+test|cargo\s+test)(?![\w-])/;

/** Detects test-runner invocations inside a Bash command string. */
export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command);
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__");
}

/** Server segment of an MCP tool name (mcp__<server>__<tool>), if any. */
export function mcpServerFromToolName(name: string): string | undefined {
  if (!isMcpToolName(name)) return undefined;
  const server = name.slice("mcp__".length).split("__")[0];
  return server === "" ? undefined : server;
}

/**
 * Line count of a written payload: newline-separated segments, ignoring
 * a single trailing newline. Empty payloads count zero lines.
 */
export function countWrittenLines(text: string): number {
  if (text === "") return 0;
  const segments = text.split("\n");
  if (segments[segments.length - 1] === "") segments.pop();
  return segments.length;
}

/** Lines a write-tool call attempts to put on disk, with the target path. */
export function writtenPayload(call: ToolCall): { filePath?: string; lines: number } {
  const filePath =
    typeof call.input.file_path === "string" ? call.input.file_path : undefined;
  let lines = 0;
  if (call.name === "Write" && typeof call.input.content === "string") {
    lines = countWrittenLines(call.input.content);
  } else if (call.name === "Edit" && typeof call.input.new_string === "string") {
    lines = countWrittenLines(call.input.new_string);
  } else if (call.name === "MultiEdit" && Array.isArray(call.input.edits)) {
    for (const edit of call.input.edits) {
      if (
        typeof edit === "object" &&
        edit !== null &&
        typeof (edit as Record<string, unknown>).new_string === "string"
      ) {
        lines += countWrittenLines((edit as Record<string, unknown>).new_string as string);
      }
    }
  }
  return { filePath, lines };
}
