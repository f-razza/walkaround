import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main, parseArgs } from "../src/cli.js";

describe("parseArgs", () => {
  it("parses the documented contract", () => {
    expect(parseArgs([])).toEqual({
      all: false,
      json: false,
      trend: false,
      subagents: false,
      help: false,
    });
    expect(parseArgs(["/some/repo"])).toEqual({
      path: "/some/repo",
      all: false,
      json: false,
      trend: false,
      subagents: false,
      help: false,
    });
    expect(parseArgs(["--all", "--json"])).toEqual({
      all: true,
      json: true,
      trend: false,
      subagents: false,
      help: false,
    });
    expect(parseArgs(["--trend"])).toEqual({
      all: false,
      json: false,
      trend: true,
      subagents: false,
      help: false,
    });
    expect(parseArgs(["--subagents"])).toEqual({
      all: false,
      json: false,
      trend: false,
      subagents: true,
      help: false,
    });
    expect(parseArgs(["--all", "--subagents", "--json"])).toEqual({
      all: true,
      json: true,
      trend: false,
      subagents: true,
      help: false,
    });
    expect(parseArgs(["-h"])).toEqual({
      all: false,
      json: false,
      trend: false,
      subagents: false,
      help: true,
    });
  });

  it("rejects unknown options, extra args and invalid combinations", () => {
    expect(parseArgs(["--nope"])).toEqual({ error: "Unknown option: --nope" });
    expect(parseArgs(["a", "b"])).toEqual({ error: "Unexpected extra argument: b" });
    expect(parseArgs(["--all", "/repo"])).toEqual({
      error: "A path and --all cannot be combined.",
    });
    expect(parseArgs(["--trend", "--subagents"])).toEqual({
      error: "--trend and --subagents cannot be combined.",
    });
  });
});

function fixturePath(name: string): string {
  return new URL(`./fixtures/${name}`, import.meta.url).pathname;
}

/** Temp projects tree holding the synthetic fixtures (cwd /home/dev/acme-rocket). */
function buildProjects(): string {
  const root = mkdtempSync(join(tmpdir(), "walkaround-cli-"));
  const dir = join(root, "projects", "-some-lying-name");
  mkdirSync(dir, { recursive: true });
  for (const name of ["happy.jsonl", "quirks.jsonl", "errors.jsonl", "sidechain-mcp.jsonl"]) {
    copyFileSync(fixturePath(name), join(dir, name));
  }
  // The happy session gets one subagent transcript.
  const subDir = join(dir, "happy", "subagents");
  mkdirSync(subDir, { recursive: true });
  copyFileSync(fixturePath("subagent.jsonl"), join(subDir, "agent-1.jsonl"));
  return join(root, "projects");
}

const projectsDir = buildProjects();
afterAll(() => rmSync(join(projectsDir, ".."), { recursive: true, force: true }));

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: string[], dir = projectsDir): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    out: (t) => {
      stdout += t;
    },
    err: (t) => {
      stderr += t;
    },
    projectsDir: dir,
    cwd: "/",
  });
  return { code, stdout, stderr };
}

describe("main", () => {
  it("reports on a repo resolved by cwd field", async () => {
    const r = await run(["/home/dev/acme-rocket"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("repo: /home/dev/acme-rocket");
    expect(r.stdout).toContain("sessions: 4");
    expect(r.stdout).toContain("Claude Code versions observed: 2.0.0 - 2.0.5");
  });

  it("emits machine-readable JSON with --json", async () => {
    const r = await run(["/home/dev/acme-rocket", "--json"]);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(json.repo).toBe("/home/dev/acme-rocket");
    expect((json.sessions as unknown[]).length).toBe(4);
  });

  it("attaches subagent transcripts to their session", async () => {
    const r = await run(["/home/dev/acme-rocket", "--json"]);
    const json = JSON.parse(r.stdout) as {
      sessions: Array<{ shortId: string; subagents: { transcripts: number; tokens: { output: number } } }>;
      aggregate: { subagents: { transcripts: number } };
    };
    const happy = json.sessions.find((s) => s.shortId === "aaaaaaaa");
    expect(happy?.subagents.transcripts).toBe(1);
    expect(happy?.subagents.tokens.output).toBe(30);
    expect(json.aggregate.subagents.transcripts).toBe(1);
    const text = await run(["/home/dev/acme-rocket"]);
    expect(text.stdout).toContain("subagents      1 transcript | in 20 | out 30 | 2 calls | 0 errors");
  });

  it("prints a friendly message and exits 0 when nothing is found", async () => {
    const r = await run(["/nowhere/special"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No Claude Code sessions found for /nowhere/special");
  });

  it("emits an empty JSON report when nothing is found with --json", async () => {
    const r = await run(["/nowhere/special", "--json"]);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    expect((json.sessions as unknown[]).length).toBe(0);
  });

  it("reports every project with --all", async () => {
    const r = await run(["--all"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("repo: /home/dev/acme-rocket");
    expect(r.stdout).toContain("sessions: 4");
  });

  it("emits a JSON array with --all --json", async () => {
    const r = await run(["--all", "--json"]);
    expect(r.code).toBe(0);
    const reports = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    expect(Array.isArray(reports)).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.repo).toBe("/home/dev/acme-rocket");
    expect((reports[0]?.sessions as unknown[]).length).toBe(4);
  });

  it("handles --all over an empty projects dir", async () => {
    const empty = mkdtempSync(join(tmpdir(), "walkaround-empty-"));
    try {
      const r = await run(["--all"], join(empty, "does-not-exist"));
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("No Claude Code sessions found");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("renders the trend table with --trend", async () => {
    const r = await run(["--trend", "/home/dev/acme-rocket"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("walkaround | trend");
    expect(r.stdout).toContain("out/prompt");
    // happy session: 710 output tokens over 2 prompts.
    expect(r.stdout).toContain("355");
    // errors session: 4 failed-ish calls out of 4, one failed test run.
    expect(r.stdout).toContain("100.0");
    expect(r.stdout).toContain("1(1F)");
  });

  it("emits trend rows with --trend --json", async () => {
    const r = await run(["--trend", "--json", "/home/dev/acme-rocket"]);
    const json = JSON.parse(r.stdout) as {
      rows: Array<{ shortId: string; outPerPrompt: number | null; errPer100Calls: number | null }>;
    };
    expect(json.rows).toHaveLength(4);
    expect(json.rows[0]).toMatchObject({ shortId: "aaaaaaaa", outPerPrompt: 355 });
    expect(json.rows.find((x) => x.shortId === "cccccccc")?.errPer100Calls).toBe(100);
  });

  it("fails on unknown options with usage on stderr", async () => {
    const r = await run(["--frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unknown option: --frobnicate");
    expect(r.stderr).toContain("Usage:");
  });

  it("prints usage with --help", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("post-flight inspection");
  });
});

/** Temp projects tree where the happy session has two subagents of unequal cost. */
function buildTwoSubagentProjects(): string {
  const root = mkdtempSync(join(tmpdir(), "walkaround-sub-"));
  const dir = join(root, "projects", "-some-lying-name");
  mkdirSync(dir, { recursive: true });
  copyFileSync(fixturePath("happy.jsonl"), join(dir, "happy.jsonl"));
  copyFileSync(fixturePath("errors.jsonl"), join(dir, "errors.jsonl"));
  const subDir = join(dir, "happy", "subagents");
  mkdirSync(subDir, { recursive: true });
  copyFileSync(fixturePath("subagent.jsonl"), join(subDir, "agent-1.jsonl"));
  copyFileSync(fixturePath("subagent-busy.jsonl"), join(subDir, "agent-2.jsonl"));
  return join(root, "projects");
}

/** Temp projects tree with sessions but no subagent transcripts at all. */
function buildNoSubagentProjects(): string {
  const root = mkdtempSync(join(tmpdir(), "walkaround-nosub-"));
  const dir = join(root, "projects", "-some-lying-name");
  mkdirSync(dir, { recursive: true });
  copyFileSync(fixturePath("errors.jsonl"), join(dir, "errors.jsonl"));
  return join(root, "projects");
}

const twoSubDir = buildTwoSubagentProjects();
const noSubDir = buildNoSubagentProjects();
afterAll(() => {
  rmSync(join(twoSubDir, ".."), { recursive: true, force: true });
  rmSync(join(noSubDir, ".."), { recursive: true, force: true });
});

describe("main --subagents", () => {
  it("renders one row per subagent, costliest output first, with the rollup totals", async () => {
    const r = await run(["/home/dev/acme-rocket", "--subagents"], twoSubDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("subagent detail");
    // agent-2 (300 out tokens) sorts above agent-1 (30 out tokens).
    const busy = r.stdout.indexOf("agent-2");
    const quiet = r.stdout.indexOf("agent-1");
    expect(busy).toBeGreaterThan(-1);
    expect(quiet).toBeGreaterThan(busy);
    // Both rows carry the parent session id.
    expect(r.stdout).toContain("aaaaaaaa  agent-2");
    expect(r.stdout).toContain("aaaaaaaa  agent-1");
    // Every cell of the busy row, in column order: model, duration, tok out,
    // calls, err t/a, lines s/t, files, retry, top tools | top churn.
    expect(r.stdout).toMatch(
      /aaaaaaaa\s+agent-2\s+claude-test-maxi\s+2 min\s+300\s+2\s+1\/0\s+3\/0\s+1\s+0\s+Bash x1, Write x1 \| src\/busy\.ts x1/,
    );
    // The totals line matches what the rollup already reports today.
    expect(r.stdout).toContain("total: 2 transcripts | in 40 | out 330 | 4 calls | 1 error");
  });

  it("keeps the default output free of the detail section", async () => {
    const r = await run(["/home/dev/acme-rocket"], twoSubDir);
    expect(r.stdout).not.toContain("subagent detail");
  });

  it("puts per-subagent entries into the JSON structure with --json", async () => {
    const r = await run(["/home/dev/acme-rocket", "--subagents", "--json"], twoSubDir);
    const json = JSON.parse(r.stdout) as {
      subagents: Array<{ parentShortId: string; metrics: { tokens: { output: number } } }>;
    };
    expect(json.subagents).toHaveLength(2);
    expect(json.subagents[0]?.parentShortId).toBe("aaaaaaaa");
    expect(json.subagents.map((s) => s.metrics.tokens.output)).toEqual([300, 30]);
  });

  it("omits the subagents key from JSON when the flag is not passed", async () => {
    const r = await run(["/home/dev/acme-rocket", "--json"], twoSubDir);
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(json.subagents).toBeUndefined();
  });

  it("composes with --all", async () => {
    const r = await run(["--all", "--subagents"], twoSubDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("subagent detail");
    expect(r.stdout).toContain("aaaaaaaa  agent-2");
  });

  it("composes with --all --json: every report in the array carries its detail", async () => {
    const r = await run(["--all", "--subagents", "--json"], twoSubDir);
    expect(r.code).toBe(0);
    const reports = JSON.parse(r.stdout) as Array<{
      subagents: Array<{ parentShortId: string; metrics: { tokens: { output: number } } }>;
    }>;
    expect(reports).toHaveLength(1);
    expect(reports[0]?.subagents.map((s) => s.metrics.tokens.output)).toEqual([300, 30]);
  });

  it("prints an honest line instead of an empty table when there are no subagents", async () => {
    const r = await run(["/home/dev/acme-rocket", "--subagents"], noSubDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no subagent transcripts under these sessions");
    expect(r.stdout).not.toContain("one row per transcript");
  });
});
