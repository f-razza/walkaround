import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main, parseArgs } from "../src/cli.js";

describe("parseArgs", () => {
  it("parses the documented contract", () => {
    expect(parseArgs([])).toEqual({ all: false, json: false, help: false });
    expect(parseArgs(["/some/repo"])).toEqual({
      path: "/some/repo",
      all: false,
      json: false,
      help: false,
    });
    expect(parseArgs(["--all", "--json"])).toEqual({ all: true, json: true, help: false });
    expect(parseArgs(["-h"])).toEqual({ all: false, json: false, help: true });
  });

  it("rejects unknown options, extra args and path+--all", () => {
    expect(parseArgs(["--nope"])).toEqual({ error: "Unknown option: --nope" });
    expect(parseArgs(["a", "b"])).toEqual({ error: "Unexpected extra argument: b" });
    expect(parseArgs(["--all", "/repo"])).toEqual({
      error: "A path and --all cannot be combined.",
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
