#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defaultProjectsDir,
  discoverAll,
  discoverForRepo,
  listSubagentFiles,
  type SessionFileInfo,
} from "./discover.js";
import { aggregateMetrics, computeSessionMetrics, type SessionMetrics } from "./metrics.js";
import { parseSession } from "./parser.js";
import { renderText, renderTrend, reportToJson, trendToJson, type RepoReport } from "./report.js";

const USAGE = `walkaround - post-flight inspection for AI coding sessions

Usage:
  walkaround [path]      report for the repo at path (default: current dir)
  walkaround --all       report for every project found
  walkaround --trend     per-session table of derived indicators
  walkaround --json      same data, machine-readable

Reads Claude Code transcripts from ~/.claude/projects. Local-only,
read-only, zero network.`;

interface CliArgs {
  path?: string;
  all: boolean;
  json: boolean;
  trend: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs | { error: string } {
  const args: CliArgs = { all: false, json: false, trend: false, help: false };
  for (const arg of argv) {
    if (arg === "--all") args.all = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--trend") args.trend = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("-")) return { error: `Unknown option: ${arg}` };
    else if (args.path !== undefined) return { error: `Unexpected extra argument: ${arg}` };
    else args.path = arg;
  }
  if (args.all && args.path !== undefined) {
    return { error: "A path and --all cannot be combined." };
  }
  return args;
}

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  projectsDir: string;
  cwd: string;
}

async function loadSession(info: SessionFileInfo): Promise<SessionMetrics | undefined> {
  let text: string;
  try {
    text = await readFile(info.filePath, "utf8");
  } catch {
    return undefined;
  }
  const subagents: SessionMetrics[] = [];
  for (const subFile of await listSubagentFiles(info.filePath)) {
    try {
      const subText = await readFile(subFile, "utf8");
      subagents.push(computeSessionMetrics(parseSession(subText), subFile));
    } catch {
      // A vanished or unreadable subagent transcript never blocks the session.
    }
  }
  return computeSessionMetrics(parseSession(text), info.filePath, subagents);
}

async function buildReport(repo: string, files: SessionFileInfo[]): Promise<RepoReport> {
  const sessions: SessionMetrics[] = [];
  for (const info of files) {
    const metrics = await loadSession(info);
    if (metrics) sessions.push(metrics);
  }
  return { repo, aggregate: aggregateMetrics(sessions) };
}

export async function main(argv: string[], io?: Partial<CliIo>): Promise<number> {
  const { out, err, projectsDir, cwd }: CliIo = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    projectsDir: defaultProjectsDir(),
    cwd: process.cwd(),
    ...io,
  };

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    err(`${parsed.error}\n\n${USAGE}\n`);
    return 1;
  }
  if (parsed.help) {
    out(`${USAGE}\n`);
    return 0;
  }

  const render = parsed.trend ? renderTrend : renderText;
  const toJson = parsed.trend ? trendToJson : reportToJson;

  if (parsed.all) {
    const groups = await discoverAll(projectsDir);
    const keys = [...groups.keys()].sort((a, b) =>
      a === "(unknown)" ? 1 : b === "(unknown)" ? -1 : a.localeCompare(b),
    );
    const reports: RepoReport[] = [];
    for (const key of keys) {
      reports.push(await buildReport(key, groups.get(key) ?? []));
    }
    if (parsed.json) {
      out(JSON.stringify(reports.map(toJson), null, 2) + "\n");
    } else if (reports.length === 0) {
      out("No Claude Code sessions found under " + projectsDir + ".\n");
    } else {
      out(reports.map(render).join("\n" + "=".repeat(72) + "\n\n"));
    }
    return 0;
  }

  const repo = resolve(cwd, parsed.path ?? ".");
  const files = await discoverForRepo(repo, projectsDir);
  if (files.length === 0 && !parsed.json) {
    out(
      `No Claude Code sessions found for ${repo}.\n` +
        `Sessions are matched by the cwd recorded inside each transcript under\n` +
        `${projectsDir}, not by folder name. If this repo is new, run a Claude Code\n` +
        `session in it first.\n`,
    );
    return 0;
  }
  const report = await buildReport(repo, files);
  out(parsed.json ? JSON.stringify(toJson(report), null, 2) + "\n" : render(report));
  return 0;
}

/** True when this file is the executed entry point (also through bin symlinks). */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`walkaround: unexpected error: ${String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
