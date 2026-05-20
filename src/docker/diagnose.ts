// Docker diagnostics. Gathers everything a user might need to share when
// reporting "Set up Docker did nothing" — OS, sandbox env vars, PATH (before
// and after augmentation), every candidate the resolver tried, and the
// output of `docker --version` / `docker info` / `docker context ls`.
//
// Every probe is wrapped in try/catch so one failed call doesn't poison the
// rest of the report. The result is a structured object; `formatDiagnosticsReport`
// turns it into plain text suitable for clipboard.

import { platform } from "node:os";

import {
  augmentPath,
  detectSandbox,
  dockerPathExtras,
  type DockerSupervisor,
} from "./supervisor";

export interface DiagnosticsReport {
  generatedAt: string;
  platform: NodeJS.Platform;
  sandbox: "flatpak" | "snap" | null;
  pathBefore: string;
  pathAfter: string;
  resolution: {
    found: boolean;
    path?: string;
    via?: "PATH" | "absolute";
    attempted: string[];
  };
  dockerVersion: ProbeResult;
  dockerInfo: ProbeResult;
  dockerContext: ProbeResult;
}

interface ProbeResult {
  ran: boolean;
  code?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
}

const INFO_TRUNCATE_LINES = 20;

export async function collectDiagnostics(
  supervisor: DockerSupervisor,
): Promise<DiagnosticsReport> {
  const plat = platform();
  const pathBefore = process.env.PATH ?? "";
  const pathAfter = augmentPath(pathBefore, dockerPathExtras(plat));
  const sandbox = detectSandbox();

  const bin = await supervisor.resolveBinary();

  const dockerVersion = await probe(supervisor, ["--version"]);
  const dockerInfo = await probe(supervisor, ["info"], INFO_TRUNCATE_LINES);
  const dockerContext = await probe(supervisor, ["context", "ls"]);

  return {
    generatedAt: new Date().toISOString(),
    platform: plat,
    sandbox,
    pathBefore,
    pathAfter,
    resolution: bin.found
      ? { found: true, path: bin.path, via: bin.via, attempted: [] }
      : { found: false, attempted: bin.attempted },
    dockerVersion,
    dockerInfo,
    dockerContext,
  };
}

async function probe(
  supervisor: DockerSupervisor,
  args: string[],
  truncateLines?: number,
): Promise<ProbeResult> {
  try {
    const res = await supervisor.runDocker(args);
    return {
      ran: true,
      code: res.code,
      stdout: truncate(res.stdout, truncateLines),
      stderr: truncate(res.stderr, truncateLines),
    };
  } catch (err) {
    return {
      ran: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function truncate(text: string, lines?: number): string {
  if (lines === undefined) return text;
  const parts = text.split("\n");
  if (parts.length <= lines) return text;
  return parts.slice(0, lines).join("\n") + `\n… (${parts.length - lines} more line(s))`;
}

export function formatDiagnosticsReport(r: DiagnosticsReport): string {
  const lines: string[] = [];
  lines.push("Feynman — Docker diagnostics");
  lines.push(`Generated: ${r.generatedAt}`);
  lines.push(`Platform:  ${r.platform}`);
  lines.push(`Sandbox:   ${r.sandbox ?? "(none)"}`);
  lines.push("");
  lines.push("PATH (inherited):");
  lines.push(indent(r.pathBefore || "(empty)"));
  lines.push("");
  lines.push("PATH (augmented for docker spawn):");
  lines.push(indent(r.pathAfter));
  lines.push("");
  lines.push("Binary resolution:");
  if (r.resolution.found) {
    lines.push(`  found via ${r.resolution.via ?? "?"}: ${r.resolution.path ?? "?"}`);
  } else {
    lines.push("  not found. Attempted:");
    for (const p of r.resolution.attempted) lines.push(`    - ${p}`);
  }
  lines.push("");
  lines.push("docker --version:");
  lines.push(formatProbe(r.dockerVersion));
  lines.push("");
  lines.push("docker info (first 20 lines):");
  lines.push(formatProbe(r.dockerInfo));
  lines.push("");
  lines.push("docker context ls:");
  lines.push(formatProbe(r.dockerContext));
  return lines.join("\n");
}

function formatProbe(p: ProbeResult): string {
  if (!p.ran) return indent(`(did not run: ${p.error ?? "unknown error"})`);
  const parts: string[] = [];
  parts.push(`exit code: ${String(p.code ?? "?")}`);
  if (p.stdout !== undefined && p.stdout.length > 0) {
    parts.push("stdout:\n" + indent(p.stdout));
  }
  if (p.stderr !== undefined && p.stderr.length > 0) {
    parts.push("stderr:\n" + indent(p.stderr));
  }
  return indent(parts.join("\n"));
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
}
