import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aggregateMetrics, computeSessionMetrics } from "../src/metrics.js";
import { parseSession } from "../src/parser.js";

// Known-answer tests: every expected number below was computed by hand
// from the fixture files, not from running the code.

const metricsFor = (name: string) =>
  computeSessionMetrics(
    parseSession(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")),
    `/fake/${name}`,
  );

describe("happy fixture", () => {
  const m = metricsFor("happy.jsonl");

  it("identifies the session", () => {
    expect(m.sessionId).toBe("aaaaaaaa-0000-4000-8000-000000000001");
    expect(m.shortId).toBe("aaaaaaaa");
    expect(m.branches).toEqual(["main"]);
    expect(m.models).toEqual(["claude-test-1"]);
    expect(m.versionRange).toEqual({ min: "2.0.0", max: "2.0.5" });
  });

  it("spans timestamps of metric events only (skipped types excluded)", () => {
    expect(m.startTime).toBe("2025-03-10T09:00:00.000Z");
    // The system line at 09:06:30 and queue-operation at 09:07:00 are
    // skipped types and must not extend the session.
    expect(m.endTime).toBe("2025-03-10T09:06:20.000Z");
    expect(m.durationMs).toBe(380_000);
  });

  it("counts human prompts, excluding meta and harness-tag lines", () => {
    expect(m.humanPrompts).toBe(2);
  });

  it("dedups token usage by requestId, last line wins", () => {
    // msg_001 spans two lines (output 50 then 80): only 80 may count.
    expect(m.tokens).toEqual({ input: 590, output: 710, cacheRead: 7400, cacheCreation: 350 });
  });

  it("builds the tool histogram and read/write split", () => {
    expect(m.toolCounts).toEqual({ Read: 1, Edit: 2, Write: 1, Bash: 1 });
    expect(m.totalToolCalls).toBe(5);
    expect(m.reads).toBe(1);
    expect(m.writes).toBe(3);
  });

  it("tracks files touched and churn", () => {
    expect(m.filesTouched).toEqual([
      "/home/dev/acme-rocket/src/engine.ts",
      "/home/dev/acme-rocket/src/thruster.ts",
      "/home/dev/acme-rocket/tests/thruster.test.ts",
    ]);
    expect(m.churn).toEqual([
      { filePath: "/home/dev/acme-rocket/src/thruster.ts", edits: 2 },
      { filePath: "/home/dev/acme-rocket/tests/thruster.test.ts", edits: 1 },
    ]);
  });

  it("splits lines written into source and test", () => {
    // Edits: 3 lines + 1 line of source; Write: 5 lines into tests/.
    expect(m.linesWritten).toEqual({ source: 4, test: 5 });
  });

  it("detects test runs and sees no errors", () => {
    expect(m.testRuns).toBe(1);
    expect(m.errors).toEqual({ toolErrors: 0, apiErrors: 0 });
    expect(m.retryChains).toEqual([]);
    expect(m.sidechain).toEqual({ events: 0, share: 0 });
    expect(m.mcp).toEqual({ calls: 0, share: 0, servers: [] });
  });

  it("passes parse stats through", () => {
    expect(m.parse.malformedLines).toBe(0);
    expect(m.parse.skippedUnknown).toEqual({});
  });
});

describe("errors fixture", () => {
  const m = metricsFor("errors.jsonl");

  it("counts tool and API errors separately", () => {
    expect(m.errors).toEqual({ toolErrors: 3, apiErrors: 1 });
  });

  it("detects one retry chain of length 2 on the same tool and file", () => {
    // Edit on core.ts fails twice, then succeeds; the later Bash failure
    // is a different tool and must not extend or create a chain.
    expect(m.retryChains).toEqual([
      { tool: "Edit", filePath: "/home/dev/acme-rocket/src/core.ts", length: 2 },
    ]);
  });

  it("counts only successful writes as lines written", () => {
    // Three 1-line Edit attempts; only the third succeeded.
    expect(m.linesWritten).toEqual({ source: 1, test: 0 });
  });

  it("still counts failed attempts in churn and histogram", () => {
    expect(m.toolCounts).toEqual({ Edit: 3, Bash: 1 });
    expect(m.churn).toEqual([
      { filePath: "/home/dev/acme-rocket/src/core.ts", edits: 3 },
    ]);
  });

  it("counts the failed npm test as a test run", () => {
    expect(m.testRuns).toBe(1);
  });

  it("excludes the <synthetic> model and zero-usage API error from totals", () => {
    expect(m.models).toEqual(["claude-test-1"]);
    expect(m.tokens).toEqual({ input: 40, output: 20, cacheRead: 0, cacheCreation: 0 });
  });
});

describe("sidechain-mcp fixture", () => {
  const m = metricsFor("sidechain-mcp.jsonl");

  it("measures the sidechain share over flagged events", () => {
    // 3 sidechain events (one prompt, one assistant, one result) out of 13 flagged.
    expect(m.sidechain).toEqual({ events: 3, share: 3 / 13 });
  });

  it("measures MCP calls by name prefix AND by attribution fields", () => {
    // mcp__rocketdb__query by prefix, plus a plain Bash call on a line
    // carrying attributionMcpServer "telemetry": 2 MCP calls out of 5.
    expect(m.mcp).toEqual({ calls: 2, share: 0.4, servers: ["rocketdb", "telemetry"] });
  });

  it("keeps sidechain tool calls in the histogram", () => {
    expect(m.toolCounts).toEqual({ Agent: 1, Read: 1, mcp__rocketdb__query: 1, Bash: 2 });
    expect(m.totalToolCalls).toBe(5);
    expect(m.reads).toBe(1);
    expect(m.writes).toBe(0);
  });

  it("does not mistake echo for a test run", () => {
    expect(m.testRuns).toBe(0);
  });

  it("does not count the sidechain user prompt as human", () => {
    expect(m.humanPrompts).toBe(1);
  });

  it("sums tokens across main and sidechain lines", () => {
    expect(m.tokens).toEqual({ input: 55, output: 55, cacheRead: 55, cacheCreation: 55 });
    expect(m.branches).toEqual(["feature/mcp"]);
  });
});

describe("quirks fixture", () => {
  const m = metricsFor("quirks.jsonl");

  it("computes metrics around garbage lines", () => {
    expect(m.humanPrompts).toBe(1);
    expect(m.tokens).toEqual({ input: 10, output: 20, cacheRead: 30, cacheCreation: 40 });
    expect(m.parse.malformedLines).toBe(2);
    expect(m.parse.skippedUnknown).toEqual({
      wibble: 2,
      "telemetry-blob": 1,
      "(missing)": 1,
    });
  });
});

describe("aggregateMetrics", () => {
  const sessions = [
    metricsFor("errors.jsonl"),
    metricsFor("happy.jsonl"),
    metricsFor("sidechain-mcp.jsonl"),
    metricsFor("quirks.jsonl"),
  ];
  const agg = aggregateMetrics(sessions);

  it("sorts sessions by start time", () => {
    expect(agg.sessions.map((s) => s.shortId)).toEqual([
      "aaaaaaaa",
      "bbbbbbbb",
      "cccccccc",
      "dddddddd",
    ]);
  });

  it("sums token totals", () => {
    expect(agg.tokens).toEqual({
      input: 590 + 40 + 55 + 10,
      output: 710 + 20 + 55 + 20,
      cacheRead: 7400 + 0 + 55 + 30,
      cacheCreation: 350 + 0 + 55 + 40,
    });
  });

  it("merges histograms, churn and counters", () => {
    expect(agg.sessionCount).toBe(4);
    expect(agg.toolCounts).toEqual({
      Read: 2,
      Edit: 5,
      Write: 1,
      Bash: 4,
      Agent: 1,
      mcp__rocketdb__query: 1,
    });
    expect(agg.totalToolCalls).toBe(14);
    expect(agg.topChurn).toEqual([
      { filePath: "/home/dev/acme-rocket/src/core.ts", edits: 3 },
      { filePath: "/home/dev/acme-rocket/src/thruster.ts", edits: 2 },
      { filePath: "/home/dev/acme-rocket/tests/thruster.test.ts", edits: 1 },
    ]);
    expect(agg.uniqueFilesTouched).toBe(5);
    expect(agg.linesWritten).toEqual({ source: 5, test: 5 });
    expect(agg.testRuns).toBe(2);
    expect(agg.errors).toEqual({ toolErrors: 3, apiErrors: 1 });
    expect(agg.retryChains).toBe(1);
    expect(agg.mcpCalls).toBe(2);
    expect(agg.sidechainEvents).toBe(3);
    expect(agg.humanPrompts).toBe(5);
  });

  it("spans the version range across sessions", () => {
    expect(agg.versionRange).toEqual({ min: "2.0.0", max: "2.0.5" });
  });

  it("handles an empty session list", () => {
    const empty = aggregateMetrics([]);
    expect(empty.sessionCount).toBe(0);
    expect(empty.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    expect(empty.versionRange).toBeUndefined();
    expect(empty.topChurn).toEqual([]);
  });
});

describe("hardening and edge cases", () => {
  it("keeps the histogram numeric for hostile tool names", () => {
    const hostile = [
      '{"type":"assistant","uuid":"a1","sessionId":"s","message":{"id":"m1","model":"claude-test-1","content":[{"type":"tool_use","id":"t1","name":"constructor","input":{}}],"usage":{"input_tokens":1,"output_tokens":1}}}',
      '{"type":"assistant","uuid":"a2","sessionId":"s","message":{"id":"m2","model":"claude-test-1","content":[{"type":"tool_use","id":"t2","name":"constructor","input":{}}],"usage":{"input_tokens":1,"output_tokens":1}}}',
      '{"type":"assistant","uuid":"a3","sessionId":"s","message":{"id":"m3","model":"claude-test-1","content":[{"type":"tool_use","id":"t3","name":"__proto__","input":{}}],"usage":{"input_tokens":1,"output_tokens":1}}}',
    ].join("\n");
    const m = computeSessionMetrics(parseSession(hostile), "/fake/hostile.jsonl");
    expect(m.toolCounts["constructor"]).toBe(2);
    expect(m.toolCounts["__proto__"]).toBe(1);
    expect(m.totalToolCalls).toBe(3);
    const agg = aggregateMetrics([m, m]);
    expect(agg.toolCounts["constructor"]).toBe(4);
    expect(agg.toolCounts["__proto__"]).toBe(2);
  });

  it("computes sane metrics for an empty transcript", () => {
    const m = computeSessionMetrics(parseSession(""), "/fake/empty.jsonl");
    expect(m.sessionId).toBe("(unknown)");
    expect(m.durationMs).toBe(0);
    expect(m.startTime).toBeUndefined();
    expect(m.versionRange).toBeUndefined();
    expect(m.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    expect(m.sidechain.share).toBe(0);
    expect(m.mcp.share).toBe(0);
  });

  it("compares versions numerically, not lexicographically", () => {
    const text = [
      '{"type":"assistant","uuid":"a1","sessionId":"s","version":"2.1.9","message":{"id":"m1","content":[]}}',
      '{"type":"assistant","uuid":"a2","sessionId":"s","version":"2.1.76","message":{"id":"m2","content":[]}}',
    ].join("\n");
    const m = computeSessionMetrics(parseSession(text), "/fake/v.jsonl");
    expect(m.versionRange).toEqual({ min: "2.1.9", max: "2.1.76" });
  });

  it("dedups usage by message id when requestId is missing, last line wins", () => {
    const text = [
      '{"type":"assistant","uuid":"a1","sessionId":"s","message":{"id":"m1","content":[],"usage":{"input_tokens":10,"output_tokens":5}}}',
      '{"type":"assistant","uuid":"a2","sessionId":"s","message":{"id":"m1","content":[],"usage":{"input_tokens":10,"output_tokens":90}}}',
    ].join("\n");
    const m = computeSessionMetrics(parseSession(text), "/fake/dedup.jsonl");
    expect(m.tokens).toEqual({ input: 10, output: 90, cacheRead: 0, cacheCreation: 0 });
  });
});

describe("retry chain edge cases", () => {
  function lines(events: object[]): string {
    return events.map((e) => JSON.stringify(e)).join("\n");
  }
  const assistantEdit = (uuid: string, id: string, file: string) => ({
    type: "assistant",
    uuid,
    sessionId: "s",
    requestId: `rq-${uuid}`,
    message: {
      id: `m-${uuid}`,
      model: "claude-test-1",
      content: [
        { type: "tool_use", id, name: "Edit", input: { file_path: file, new_string: "x" } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const failure = (uuid: string, source: string, id: string) => ({
    type: "user",
    uuid,
    sessionId: "s",
    sourceToolAssistantUUID: source,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, is_error: true }],
    },
    toolUseResult: "Error: synthetic",
  });

  it("does not chain failures on different files", () => {
    const text = lines([
      assistantEdit("a1", "t1", "/p/a.ts"),
      failure("u1", "a1", "t1"),
      assistantEdit("a2", "t2", "/p/b.ts"),
      failure("u2", "a2", "t2"),
    ]);
    const m = computeSessionMetrics(parseSession(text), "/fake/x.jsonl");
    expect(m.errors.toolErrors).toBe(2);
    expect(m.retryChains).toEqual([]);
  });

  it("counts a chain of three consecutive failures once", () => {
    const text = lines([
      assistantEdit("a1", "t1", "/p/a.ts"),
      failure("u1", "a1", "t1"),
      assistantEdit("a2", "t2", "/p/a.ts"),
      failure("u2", "a2", "t2"),
      assistantEdit("a3", "t3", "/p/a.ts"),
      failure("u3", "a3", "t3"),
    ]);
    const m = computeSessionMetrics(parseSession(text), "/fake/x.jsonl");
    expect(m.retryChains).toEqual([{ tool: "Edit", filePath: "/p/a.ts", length: 3 }]);
  });

  it("never chains failures whose source call cannot be resolved", () => {
    const text = lines([
      // Results pointing at a non-existent assistant uuid: unattributable.
      failure("u1", "missing", "t1"),
      failure("u2", "missing", "t2"),
      failure("u3", "missing", "t3"),
    ]);
    const m = computeSessionMetrics(parseSession(text), "/fake/x.jsonl");
    expect(m.errors.toolErrors).toBe(3);
    expect(m.retryChains).toEqual([]);
  });
});
