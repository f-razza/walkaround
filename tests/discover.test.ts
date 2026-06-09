import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverAll, discoverForRepo, listSessionFiles } from "../src/discover.js";

function line(fields: Record<string, unknown>): string {
  return JSON.stringify(fields) + "\n";
}

function userLine(sessionId: string, cwd?: string): string {
  return line({
    type: "user",
    uuid: `u-${Math.abs(sessionId.length + (cwd?.length ?? 0))}`,
    sessionId,
    ...(cwd !== undefined ? { cwd } : {}),
    message: { role: "user", content: "synthetic" },
  });
}

/**
 * Fake ~/.claude/projects tree. Folder names deliberately lie about the
 * cwd they contain: only the cwd field inside each file may be trusted.
 */
function buildTree(): string {
  const root = mkdtempSync(join(tmpdir(), "walkaround-discover-"));
  const projects = join(root, "projects");

  const dirA = join(projects, "-home-dev-somewhere-else");
  mkdirSync(dirA, { recursive: true });
  writeFileSync(
    join(dirA, "s1.jsonl"),
    line({ type: "ai-title", sessionId: "s1", aiTitle: "t" }) +
      userLine("s1", "/synthetic/repo-a") +
      userLine("s1", "/synthetic/repo-a"),
  );
  writeFileSync(
    join(dirA, "s4.jsonl"),
    userLine("s4", "/synthetic/repo-a") + userLine("s4", "/synthetic/repo-b"),
  );
  writeFileSync(join(dirA, "s3-no-cwd.jsonl"), line({ type: "mode", mode: "default" }));
  writeFileSync(join(dirA, "garbage.jsonl"), "not json at all\n{broken\n");
  writeFileSync(join(dirA, "empty.jsonl"), "");
  writeFileSync(join(dirA, "notes.txt"), "ignore me");

  // Subagent transcript: same sessionId and cwd as s1, one level deeper.
  const subagents = join(dirA, "s1", "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(subagents, "agent-x.jsonl"), userLine("s1", "/synthetic/repo-a"));

  const dirB = join(projects, "-synthetic-repo-b");
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirB, "s2.jsonl"), userLine("s2", "/synthetic/repo-b"));

  return projects;
}

const projects = buildTree();
afterAll(() => rmSync(join(projects, ".."), { recursive: true, force: true }));

describe("listSessionFiles", () => {
  it("lists only top-level .jsonl files, never subagent transcripts", async () => {
    const files = await listSessionFiles(projects);
    const names = files.map((f) => f.split("/").pop());
    expect(names).toEqual(["empty.jsonl", "garbage.jsonl", "s1.jsonl", "s3-no-cwd.jsonl", "s4.jsonl", "s2.jsonl"]);
    expect(files.some((f) => f.includes("subagents"))).toBe(false);
  });

  it("returns [] for a missing projects dir", async () => {
    expect(await listSessionFiles("/nonexistent/walkaround-nowhere")).toEqual([]);
  });
});

describe("discoverForRepo", () => {
  it("matches sessions by the cwd field, not the folder name", async () => {
    const found = await discoverForRepo("/synthetic/repo-a", projects);
    expect(found.map((f) => f.sessionId).sort()).toEqual(["s1", "s4"]);
  });

  it("matches any cwd observed in a file", async () => {
    const found = await discoverForRepo("/synthetic/repo-b", projects);
    expect(found.map((f) => f.sessionId).sort()).toEqual(["s2", "s4"]);
  });

  it("ignores trailing slashes on the repo path", async () => {
    const found = await discoverForRepo("/synthetic/repo-a/", projects);
    expect(found.map((f) => f.sessionId).sort()).toEqual(["s1", "s4"]);
  });

  it("finds nothing for an unrelated repo", async () => {
    expect(await discoverForRepo("/synthetic/repo-zzz", projects)).toEqual([]);
  });

  it("resolves the repo path through symlinks", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "walkaround-symlink-"));
    const real = join(scratch, "real-repo");
    const alias = join(scratch, "alias-repo");
    mkdirSync(real);
    symlinkSync(real, alias);
    try {
      const ownProjects = join(scratch, "projects");
      const dir = join(ownProjects, "-via-symlink");
      mkdirSync(dir, { recursive: true });
      const { realpathSync } = await import("node:fs");
      writeFileSync(join(dir, "s5.jsonl"), userLine("s5", realpathSync(real)));
      const found = await discoverForRepo(alias, ownProjects);
      expect(found.map((f) => f.sessionId)).toEqual(["s5"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("discoverAll", () => {
  it("groups sessions by their first observed cwd", async () => {
    const groups = await discoverAll(projects);
    const ids = (key: string) => (groups.get(key) ?? []).map((f) => f.sessionId).sort();
    expect(ids("/synthetic/repo-a")).toContain("s1");
    expect(ids("/synthetic/repo-a")).toContain("s4");
    expect(ids("/synthetic/repo-b")).toEqual(["s2"]);
  });

  it("groups cwd-less files under (unknown)", async () => {
    const groups = await discoverAll(projects);
    const unknown = groups.get("(unknown)") ?? [];
    expect(unknown.length).toBeGreaterThanOrEqual(3);
    expect(unknown.every((f) => f.cwds.length === 0)).toBe(true);
  });
});
