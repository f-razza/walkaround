import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export interface SessionFileInfo {
  filePath: string;
  sessionId?: string;
  /** Distinct cwd values observed inside the file, in first-seen order. */
  cwds: string[];
}

export function defaultProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

function stripTrailingSep(p: string): string {
  while (p.length > 1 && p.endsWith(sep)) p = p.slice(0, -1);
  return p;
}

function normalize(p: string): string {
  return stripTrailingSep(resolve(p));
}

/**
 * List candidate session transcripts: *.jsonl files sitting directly inside
 * each project directory. Subagent transcripts live one level deeper
 * (<session-id>/subagents/agent-*.jsonl) and share the parent sessionId,
 * so descending into subdirectories would double-count sessions.
 */
export async function listSessionFiles(projectsDir: string): Promise<string[]> {
  let projectDirs;
  try {
    projectDirs = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = join(projectsDir, dir.name);
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(join(dirPath, entry.name));
      }
    }
  }
  return files.sort();
}

/**
 * Cheap scan of one transcript for routing fields only (cwd, sessionId).
 * The folder name encodes a cwd too, but it is lossy — never trust it;
 * only the cwd fields inside the file decide where a session belongs.
 */
export async function inspectSessionFile(filePath: string): Promise<SessionFileInfo> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return { filePath, cwds: [] };
  }
  const cwds: string[] = [];
  const seen = new Set<string>();
  let sessionId: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.cwd === "string" && !seen.has(obj.cwd)) {
      seen.add(obj.cwd);
      cwds.push(obj.cwd);
    }
    if (sessionId === undefined && typeof obj.sessionId === "string") {
      sessionId = obj.sessionId;
    }
  }
  return { filePath, sessionId, cwds };
}

/**
 * Subagent transcripts attached to a session: every *.jsonl under
 * <session-dir>/<session-name>/subagents/, recursively. Two layouts exist
 * in the wild: flat agent-*.jsonl and workflows/<id>/agent-*.jsonl.
 */
export async function listSubagentFiles(sessionFilePath: string): Promise<string[]> {
  const base = sessionFilePath.replace(/\.jsonl$/, "");
  const root = join(base, "subagents");
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(full);
    }
  }
  await walk(root);
  return found.sort();
}

/** All sessions whose observed cwd matches the given repo path. */
export async function discoverForRepo(
  repoPath: string,
  projectsDir: string = defaultProjectsDir(),
): Promise<SessionFileInfo[]> {
  const targets = new Set([normalize(repoPath)]);
  try {
    // Repos are often reached through symlinks (/tmp on macOS); accept both spellings.
    targets.add(stripTrailingSep(await realpath(repoPath)));
  } catch {
    // Path may no longer exist; match on the literal spelling only.
  }
  const matches: SessionFileInfo[] = [];
  for (const file of await listSessionFiles(projectsDir)) {
    const info = await inspectSessionFile(file);
    if (info.cwds.some((c) => targets.has(normalize(c)))) {
      matches.push(info);
    }
  }
  return matches;
}

/**
 * Every session under the projects dir, grouped by the first cwd observed
 * in each file. Sessions with no cwd at all are grouped under "(unknown)".
 */
export async function discoverAll(
  projectsDir: string = defaultProjectsDir(),
): Promise<Map<string, SessionFileInfo[]>> {
  const groups = new Map<string, SessionFileInfo[]>();
  for (const file of await listSessionFiles(projectsDir)) {
    const info = await inspectSessionFile(file);
    const key = info.cwds[0] !== undefined ? normalize(info.cwds[0]) : "(unknown)";
    const group = groups.get(key);
    if (group) group.push(info);
    else groups.set(key, [info]);
  }
  return groups;
}
