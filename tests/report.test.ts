import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aggregateMetrics, computeSessionMetrics } from "../src/metrics.js";
import { parseSession } from "../src/parser.js";
import { renderText, reportToJson, type RepoReport } from "../src/report.js";

const metricsFor = (name: string) =>
  computeSessionMetrics(
    parseSession(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")),
    `/fake/${name}`,
  );

function fullReport(): RepoReport {
  return {
    repo: "/home/dev/acme-rocket",
    aggregate: aggregateMetrics([
      metricsFor("happy.jsonl"),
      metricsFor("quirks.jsonl"),
      metricsFor("errors.jsonl"),
      metricsFor("sidechain-mcp.jsonl"),
    ]),
  };
}

describe("renderText", () => {
  it("renders the full multi-session report", () => {
    expect(renderText(fullReport())).toMatchSnapshot();
  });

  it("renders a single-session report", () => {
    const report: RepoReport = {
      repo: "/home/dev/acme-rocket",
      aggregate: aggregateMetrics([metricsFor("happy.jsonl")]),
    };
    expect(renderText(report)).toMatchSnapshot();
  });

  it("states the observed Claude Code version range", () => {
    const text = renderText(fullReport());
    expect(text).toContain("Claude Code versions observed: 2.0.0 - 2.0.5");
  });

  it("says so when no version was recorded", () => {
    const report: RepoReport = { repo: "/x", aggregate: aggregateMetrics([]) };
    expect(renderText(report)).toContain("Claude Code version: not recorded");
  });

  it("shows paths relative to the repo", () => {
    const text = renderText(fullReport());
    expect(text).toContain("src/core.ts x3");
    expect(text).not.toContain("/home/dev/acme-rocket/src/core.ts x3");
  });

  it("surfaces unknown event types in the skipped line", () => {
    const text = renderText(fullReport());
    expect(text).toContain("unknown types: wibble x2");
  });
});

describe("reportToJson", () => {
  it("is valid JSON with the same data and a stable shape", () => {
    const json = JSON.parse(JSON.stringify(reportToJson(fullReport()))) as Record<
      string,
      unknown
    >;
    expect(json.repo).toBe("/home/dev/acme-rocket");
    expect(json.claudeCodeVersions).toEqual({ min: "2.0.0", max: "2.0.5" });
    const sessions = json.sessions as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(4);
    expect(sessions[0]?.shortId).toBe("aaaaaaaa");
    const aggregate = json.aggregate as Record<string, unknown>;
    expect(aggregate.sessionCount).toBe(4);
    expect(aggregate.sessions).toBeUndefined();
    expect(aggregate.tokens).toEqual({
      input: 690,
      output: 800,
      cacheRead: 7480,
      cacheCreation: 440,
    });
  });
});
