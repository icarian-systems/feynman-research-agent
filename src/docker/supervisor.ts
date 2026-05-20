// Docker supervisor — Local Docker mode only. See docs/ARCHITECTURE.md §6.1.
//
// Real implementation. Cross-platform (macOS / Linux / Windows): all subprocess
// invocation goes through `child_process.spawn` against the `docker` binary on
// PATH. No platform-specific paths beyond env-file location (handled via
// `os.homedir()`).
//
// First-run flow (driven by the settings tab):
//   1. check()            — `docker --version` + `docker info`.
//   2. pull(imageTag)     — `docker pull <imageTag>`. Progress streams via
//                           the `onProgress` callback passed to the call.
//   3. start(prefs, env)  — env-file (chmod 600 on POSIX); `docker rm -f`
//                           any stale name; probe + auto-bump port; then
//                           `docker run -d --env-file <path> -p <port>:7777`.
//   4. status()           — `docker inspect` on the configured name.
//   5. stop()             — `docker stop` + `docker rm`. Idempotent.
//   6. pullLatest()       — convenience wrapper over pull(configuredTag).

import { spawn, type SpawnOptions } from "node:child_process";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

import type { DockerPrefs } from "./prefs";

/**
 * Generate a cryptographically random 32-byte bearer token, hex-encoded. The
 * server picks this up via the env-file as `FEYNMAN_AUTH_TOKEN`; the plugin
 * sends it as `Authorization: Bearer <token>` on every request. Without a
 * match the server rejects with 401 — see docs/SETUP.md security note.
 */
export function generateAuthToken(): string {
  return randomBytes(32).toString("hex");
}

/** Result shape for `check()`. */
export interface DockerCheckResult {
  ok: boolean;
  /**
   * One of:
   *  - "not-installed" → `docker` binary missing on PATH.
   *  - "daemon-down"   → binary present but `docker info` failed.
   *  - undefined when ok=true.
   */
  reason?: "not-installed" | "daemon-down";
  /** Optional human-readable detail attached when ok=false. */
  detail?: string;
}

export type DockerStatus = "running" | "stopped" | "not-installed";

export interface DockerStartResult {
  containerName: string;
  port: number;
}

/** Pull progress callback. Receives each line from `docker pull` stdout. */
export type PullProgress = (line: string) => void;

/**
 * Resolve the env-file location for the current platform.
 *
 *   - POSIX:  `~/.feynman/env`
 *   - Win32:  `%USERPROFILE%\.feynman\env`
 *
 * The file is mode 0600 on POSIX. On win32 we rely on default per-user
 * profile ACLs — `chmod` is a no-op on win32 in Node.
 */
export function defaultEnvFilePath(): string {
  return join(homedir(), ".feynman", "env");
}

/** Stable default container name when caller doesn't supply one. */
export const DEFAULT_CONTAINER_NAME = "feynman-server";

/**
 * Write the env-file consumed by `docker run --env-file`. Creates the parent
 * directory if needed. Applies `chmod 600` on POSIX; no-op on win32.
 *
 * Never logs the file contents. Caller is responsible for keeping the
 * record off of stdout / Notices.
 */
export async function writeEnvFile(
  envFilePath: string,
  vars: Record<string, string>,
): Promise<void> {
  await mkdir(dirname(envFilePath), { recursive: true });
  const body =
    Object.entries(vars)
      // Keep ordering deterministic so diffs aren't noisy.
      .map(([k, v]) => `${k}=${escapeEnvValue(v)}`)
      .join("\n") + "\n";
  await writeFile(envFilePath, body, { encoding: "utf8" });
  if (platform() !== "win32") {
    await chmod(envFilePath, 0o600);
  }
}

/**
 * Escape a value for the docker `--env-file` format. The format is roughly
 * dotenv: `KEY=VALUE` with no quoting; CRs and LFs are forbidden because
 * the parser is line-oriented. We strip them.
 */
function escapeEnvValue(v: string): string {
  return v.replace(/[\r\n]/g, "");
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a process and collect stdout/stderr. Resolves regardless of exit
 * code; rejects only on spawn failure (e.g. ENOENT).
 */
function spawnCollect(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {},
  onStdoutLine?: (line: string) => void,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    let stdout = "";
    let stderr = "";
    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (onStdoutLine !== undefined) {
        buf += text;
        let idx = buf.indexOf("\n");
        while (idx !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          if (line.length > 0) onStdoutLine(line);
          buf = buf.slice(idx + 1);
          idx = buf.indexOf("\n");
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      if (onStdoutLine !== undefined && buf.length > 0) {
        onStdoutLine(buf);
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Probe whether a TCP port is bindable on 127.0.0.1. Resolves true if free,
 * false if EADDRINUSE / EACCES.
 */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => {
      resolve(false);
    });
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, "127.0.0.1");
  });
}

/**
 * Find a free port starting at `start`, scanning at most `windowSize`
 * candidates. Returns -1 if none found.
 */
async function findFreePort(start: number, windowSize = 10): Promise<number> {
  for (let p = start; p < start + windowSize; p++) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design
    if (await portIsFree(p)) return p;
  }
  return -1;
}

export class DockerSupervisor {
  /** Bumped to the actual chosen port after `start()`. */
  private lastPort: number | null = null;
  private lastContainerName: string | null = null;

  /**
   * Probe the Docker installation. Distinguishes:
   *   - binary missing      → { ok: false, reason: "not-installed" }
   *   - daemon not running  → { ok: false, reason: "daemon-down" }
   *   - healthy             → { ok: true }
   */
  async check(): Promise<DockerCheckResult> {
    try {
      const versionRes = await spawnCollect("docker", ["--version"]);
      if (versionRes.code !== 0) {
        return {
          ok: false,
          reason: "not-installed",
          detail: versionRes.stderr.trim() || "docker --version exited nonzero",
        };
      }
    } catch (err) {
      // ENOENT — binary not on PATH.
      return {
        ok: false,
        reason: "not-installed",
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    try {
      const infoRes = await spawnCollect("docker", ["info"]);
      if (infoRes.code !== 0) {
        return {
          ok: false,
          reason: "daemon-down",
          detail: infoRes.stderr.trim() || "docker info exited nonzero",
        };
      }
    } catch (err) {
      return {
        ok: false,
        reason: "daemon-down",
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    return { ok: true };
  }

  /**
   * Resolve `imageTag` to a runnable state. If the image is already present
   * locally (`docker image inspect` succeeds), no-op — supports the
   * locally-built-image workflow (e.g. `docker build -t feynman-server .`).
   * Otherwise `docker pull <imageTag>` and stream progress lines through
   * `onProgress`. On pull failure the error includes a hint about building
   * locally, since v1 ships without a published registry image.
   */
  async pull(imageTag: string, onProgress?: PullProgress): Promise<void> {
    const inspect = await spawnCollect("docker", ["image", "inspect", imageTag]);
    if (inspect.code === 0) {
      onProgress?.(`Using local image ${imageTag}`);
      return;
    }
    const res = await spawnCollect("docker", ["pull", imageTag], {}, onProgress);
    if (res.code !== 0) {
      const stderr = res.stderr.trim() || res.stdout.trim();
      throw new Error(
        `Image '${imageTag}' not found locally or on a registry. ` +
          `Build it first (e.g. 'docker build -t ${imageTag} .' in the server repo) ` +
          `or override the image tag in Settings → Feynman → Docker. ` +
          `Underlying error: ${stderr}`,
      );
    }
  }

  /**
   * Full launch path:
   *   1. Ensure env-file exists with `ANTHROPIC_API_KEY` + `FEYNMAN_AUTH_TOKEN`
   *      (caller supplies values via `envVars`; supervisor writes the file).
   *   2. `docker rm -f <name>` to clear any stale container with the same name.
   *   3. Probe `prefs.hostPort`; auto-bump up to 10 ports if occupied.
   *   4. `docker run -d --name <name> --env-file <envFilePath> -p
   *      127.0.0.1:<port>:7777 -v <vaultMountSrc>:<vaultMountDst>
   *      <imageTag>`.
   *
   * Returns the chosen container name + host port (may differ from prefs
   * if auto-bumped).
   *
   * `envVars` is optional; if omitted the env-file is left untouched (or
   * created empty so docker can read it). Agent 4 (Wave 2) populates it
   * with the bearer token + Anthropic key at the caller site.
   */
  async start(
    prefs: DockerPrefs,
    envFilePath: string,
    envVars?: Record<string, string>,
  ): Promise<DockerStartResult> {
    const containerName = prefs.containerName || DEFAULT_CONTAINER_NAME;

    // 1. env-file write (only if caller provided values; otherwise assume
    // a prior call has populated it).
    if (envVars !== undefined) {
      await writeEnvFile(envFilePath, envVars);
    }

    // 2. Force-remove any stale container with the same name. Tolerate
    // the no-such-container error (exit 1 with "No such container").
    await spawnCollect("docker", ["rm", "-f", containerName]);

    // 3. Port selection.
    const desired = prefs.hostPort > 0 ? prefs.hostPort : 7777;
    const port = await findFreePort(desired, 10);
    if (port === -1) {
      throw new Error(
        `No free port in range ${desired}..${desired + 9}. Stop the process holding that range and retry.`,
      );
    }

    // 4. docker run. Note: --env-file (NOT -e KEY=VALUE) — keys never appear
    // on the command line or in `docker inspect`'s env array tail.
    const args = [
      "run",
      "-d",
      "--name",
      containerName,
      "--env-file",
      envFilePath,
      "-p",
      `127.0.0.1:${String(port)}:7777`,
    ];
    if (prefs.vaultMountSrc.length > 0) {
      const dst = prefs.vaultMountDst || "/vault";
      args.push("-v", `${prefs.vaultMountSrc}:${dst}`);
    }
    args.push(prefs.imageTag);

    const res = await spawnCollect("docker", args);
    if (res.code !== 0) {
      throw new Error(
        `docker run failed (exit ${res.code ?? "?"}): ${
          res.stderr.trim() || res.stdout.trim()
        }`,
      );
    }

    this.lastPort = port;
    this.lastContainerName = containerName;
    return { containerName, port };
  }

  /**
   * `docker stop <name>` then `docker rm <name>`. Idempotent — missing
   * container is not an error.
   */
  async stop(containerName?: string): Promise<void> {
    const name = containerName ?? this.lastContainerName ?? DEFAULT_CONTAINER_NAME;
    await spawnCollect("docker", ["stop", name]);
    await spawnCollect("docker", ["rm", name]);
  }

  /**
   * Coarse-grained state. "running" / "stopped" / "not-installed". We do
   * not surface "starting" or "unhealthy" in v1 — the workflow client's
   * health probe carries that signal.
   */
  async status(containerName?: string): Promise<DockerStatus> {
    const name = containerName ?? this.lastContainerName ?? DEFAULT_CONTAINER_NAME;
    let inspect: SpawnResult;
    try {
      inspect = await spawnCollect("docker", [
        "inspect",
        "-f",
        "{{.State.Running}}",
        name,
      ]);
    } catch {
      return "not-installed";
    }
    if (inspect.code !== 0) {
      // No such container, or daemon down. Re-check to distinguish.
      const c = await this.check();
      if (!c.ok && c.reason === "not-installed") return "not-installed";
      return "stopped";
    }
    return inspect.stdout.trim() === "true" ? "running" : "stopped";
  }

  /** Convenience: re-pull the configured tag. */
  async pullLatest(imageTag: string, onProgress?: PullProgress): Promise<void> {
    await this.pull(imageTag, onProgress);
  }
}
