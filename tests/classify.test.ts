import { describe, expect, it } from "vitest";
import {
  countWrittenLines,
  isMcpToolName,
  isTestCommand,
  isTestPath,
  mcpServerFromToolName,
  writtenPayload,
} from "../src/classify.js";

describe("isTestPath", () => {
  it.each([
    ["/p/src/foo.test.ts", true],
    ["/p/src/foo.spec.tsx", true],
    ["/p/__tests__/foo.ts", true],
    ["/p/tests/helpers.py", true],
    ["/p/test/unit.go", true],
    ["/p/src/foo.ts", false],
    ["/p/contest/entry.ts", false],
    ["/p/latest/notes.md", false],
    ["/p/src/testimonial.ts", false],
    ["/p/attestation.test.md", true],
  ])("%s -> %s", (path, expected) => {
    expect(isTestPath(path)).toBe(expected);
  });
});

describe("isTestCommand", () => {
  it.each([
    ["npm test", true],
    ["npm  test -- --watch", true],
    ["npx vitest run", true],
    ["node_modules/.bin/jest --ci", true],
    ["pytest tests/", true],
    ["go test ./...", true],
    ["cargo test --workspace", true],
    ["cd app && npm test", true],
    ["echo done", false],
    ["npm run build", false],
    ["pytest-helper --version", false],
    ["cargo build", false],
    ["go vet ./...", false],
  ])("%s -> %s", (command, expected) => {
    expect(isTestCommand(command)).toBe(expected);
  });
});

describe("MCP tool names", () => {
  it("detects the mcp__ prefix and extracts the server", () => {
    expect(isMcpToolName("mcp__rocketdb__query")).toBe(true);
    expect(isMcpToolName("Read")).toBe(false);
    expect(mcpServerFromToolName("mcp__rocketdb__query")).toBe("rocketdb");
    expect(mcpServerFromToolName("Read")).toBeUndefined();
    expect(mcpServerFromToolName("mcp__")).toBeUndefined();
  });
});

describe("countWrittenLines", () => {
  it.each([
    ["", 0],
    ["one line no newline", 1],
    ["one line\n", 1],
    ["a\nb\nc", 3],
    ["a\nb\nc\n", 3],
    ["\n", 1],
  ])("%j -> %d", (text, expected) => {
    expect(countWrittenLines(text)).toBe(expected);
  });
});

describe("writtenPayload", () => {
  it("reads Write content", () => {
    expect(
      writtenPayload({ name: "Write", input: { file_path: "/p/a.ts", content: "x\ny\n" } }),
    ).toEqual({ filePath: "/p/a.ts", lines: 2 });
  });

  it("reads Edit new_string", () => {
    expect(
      writtenPayload({ name: "Edit", input: { file_path: "/p/a.ts", new_string: "x" } }),
    ).toEqual({ filePath: "/p/a.ts", lines: 1 });
  });

  it("sums MultiEdit edits", () => {
    expect(
      writtenPayload({
        name: "MultiEdit",
        input: {
          file_path: "/p/a.ts",
          edits: [{ new_string: "x\ny" }, { new_string: "z" }, { broken: true }],
        },
      }),
    ).toEqual({ filePath: "/p/a.ts", lines: 3 });
  });

  it("tolerates missing or malformed input", () => {
    expect(writtenPayload({ name: "Write", input: {} })).toEqual({
      filePath: undefined,
      lines: 0,
    });
    expect(writtenPayload({ name: "Edit", input: { new_string: 42 } })).toEqual({
      filePath: undefined,
      lines: 0,
    });
  });
});
