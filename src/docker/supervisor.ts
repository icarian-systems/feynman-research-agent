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
import { existsSync } from "node:fs";

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
   *  - "not-installed"     → `docker` binary missing on PATH and all known
   *                          install locations.
   *  - "daemon-down"       → binary present but `docker info` could not
   *                          reach the daemon.
   *  - "permission-denied" → Linux: socket exists but the user lacks
   *                          permission (usually missing docker group).
   *  - "sandboxed"         → Linux: Obsidian is running inside Flatpak/Snap
   *                          and cannot reach the daemon socket.
   *  - undefined when ok=true.
   */
  reason?: "not-installed" | "daemon-down" | "permission-denied" | "sandboxed";
  /** Optional human-readable detail attached when ok=false. */
  detail?: string;
  /** Populated when reason="not-installed": the candidate paths we tried. */
  attempted?: string[];
}

export type DockerCheckReason = NonNullable<DockerCheckResult["reason"]>;

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
 * Platform-specific candidate directories the Docker CLI is commonly
 * installed into. Obsidian launched from a GUI on macOS inherits launchd's
 * stripped PATH (typically `/usr/bin:/bin:/usr/sbin:/sbin`) and cannot see
 * the `/usr/local/bin/docker` symlink Docker Desktop creates. We prepend
 * these to spawn env on the affected platforms. Linux distros generally
 * inherit a usable PATH from the desktop session.
 */
export function dockerPathExtras(plat: NodeJS.Platform = platform()): string[] {
  if (plat === "darwin") {
    return [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/Applications/Docker.app/Contents/Resources/bin",
    ];
  }
  if (plat === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const candidates = ["C:\\Program Files\\Docker\\Docker\\resources\\bin"];
    if (localAppData.length > 0) {
      candidates.push(`${localAppData}\\Docker\\bin`);
    }
    return candidates;
  }
  return [];
}

/**
 * Prepend `extras` to `basePath` without duplicating entries. Order is
 * preserved; extras land first so a Docker Desktop install shadows any
 * stale entries the user may have on PATH.
 */
export function augmentPath(
  basePath: string,
  extras: readonly string[],
  sep = platform() === "win32" ? ";" : ":",
): string {
  const parts = basePath.length > 0 ? basePath.split(sep) : [];
  const seen = new Set(parts);
  const prepend = extras.filter((p) => !seen.has(p));
  return [...prepend, ...parts].join(sep);
}

/** Result of resolving the Docker CLI binary location. */
export type DockerBinaryResolution =
  | { found: true; path: string; via: "PATH" | "absolute" }
  | { found: false; attempted: string[] };

/**
 * Probe for a working Docker CLI. Tries the bare `docker` (or `docker.exe`)
 * command under the augmented PATH first; falls back to absolute candidates
 * from `dockerPathExtras`. A candidate is considered valid only if
 * `docker --version` exits 0 — file existence alone isn't enough since
 * permissions could prevent execution.
 */
export async function resolveDockerBinary(
  plat: NodeJS.Platform = platform(),
): Promise<DockerBinaryResolution> {
  const extras = dockerPathExtras(plat);
  const augmented = augmentPath(process.env.PATH ?? "", extras);
  const env = { ...process.env, PATH: augmented };
  const attempted: string[] = [];

  const bare = plat === "win32" ? "docker.exe" : "docker";
  attempted.push(`PATH:${bare}`);
  try {
    const res = await spawnCollect(bare, ["--version"], { env });
    if (res.code === 0) return { found: true, path: bare, via: "PATH" };
  } catch {
    // ENOENT — fall through to absolute candidates.
  }

  const binName = plat === "win32" ? "docker.exe" : "docker";
  for (const dir of extras) {
    const candidate = join(dir, binName);
    attempted.push(candidate);
    if (!existsSync(candidate)) continue;
    try {
      const res = await spawnCollect(candidate, ["--version"], { env });
      if (res.code === 0) return { found: true, path: candidate, via: "absolute" };
    } catch {
      // try next
    }
  }

  return { found: false, attempted };
}

/**
 * Detect a Linux sandbox that blocks Docker socket access. Returns the
 * sandbox name if detected, otherwise null. Currently identifies Flatpak
 * (FLATPAK_ID) and Snap (SNAP).
 */
export function detectSandbox(): "flatpak" | "snap" | null {
  if (platform() !== "linux") return null;
  if (process.env.FLATPAK_ID !== undefined) return "flatpak";
  if (process.env.SNAP !== undefined) return "snap";
  return null;
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
  /** Cached binary resolution. `null` means "not yet resolved this session". */
  private resolution: DockerBinaryResolution | null = null;

  /**
   * Lazily resolve the Docker CLI. Cached on the instance once a working
   * binary is found; re-probed on every call while unresolved so a user
   * who installs Docker mid-session doesn't have to restart Obsidian.
   */
  async resolveBinary(): Promise<DockerBinaryResolution> {
    if (this.resolution?.found === true) return this.resolution;
    this.resolution = await resolveDockerBinary();
    return this.resolution;
  }

  /** Augmented env (with extended PATH) for every docker spawn. */
  private dockerEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: augmentPath(process.env.PATH ?? "", dockerPathExtras()),
    };
  }

  /**
   * Run `docker <args>`. Uses the resolved binary path so we don't rely on
   * the caller's PATH containing Docker. Throws on spawn failure
   * (e.g. ENOENT after resolution returned a stale path); resolves with
   * the SpawnResult otherwise (including nonzero exit codes).
   */
  async runDocker(
    args: string[],
    opts: SpawnOptions = {},
    onStdoutLine?: (line: string) => void,
  ): Promise<SpawnResult> {
    const res = await this.resolveBinary();
    const cmd = res.found ? res.path : (platform() === "win32" ? "docker.exe" : "docker");
    return spawnCollect(
      cmd,
      args,
      { env: this.dockerEnv(), ...opts },
      onStdoutLine,
    );
  }

  /**
   * Probe the Docker installation. Distinguishes:
   *   - binary missing       → { ok: false, reason: "not-installed", attempted }
   *   - sandboxed Obsidian   → { ok: false, reason: "sandboxed" }
   *   - daemon not running   → { ok: false, reason: "daemon-down" }
   *   - permission denied    → { ok: false, reason: "permission-denied" } (Linux)
   *   - healthy              → { ok: true }
   */
  async check(): Promise<DockerCheckResult> {
    // Pre-check: Flatpak/Snap sandbox cannot reach the docker socket no
    // matter what `docker` says. Surface a distinct error before spawn so
    // the user gets actionable copy instead of a confusing "daemon-down".
    const sandbox = detectSandbox();
    if (sandbox !== null) {
      return {
        ok: false,
        reason: "sandboxed",
        detail: `Detected ${sandbox} sandbox env (${sandbox === "flatpak" ? "FLATPAK_ID" : "SNAP"} is set).`,
      };
    }

    const bin = await this.resolveBinary();
    if (!bin.found) {
      return {
        ok: false,
        reason: "not-installed",
        attempted: bin.attempted,
        detail: `Tried ${bin.attempted.length} candidate path(s); none responded to 'docker --version'.`,
      };
    }

    try {
      const infoRes = await this.runDocker(["info"]);
      if (infoRes.code !== 0) {
        const stderr = infoRes.stderr.trim();
        if (
          platform() === "linux" &&
          /permission denied|dial unix.*permission denied/i.test(stderr)
        ) {
          return { ok: false, reason: "permission-denied", detail: stderr };
        }
        return {
          ok: false,
          reason: "daemon-down",
          detail: stderr || "docker info exited nonzero",
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
    // First: exact-tag inspect. Cheap, matches the common case (image tagged
    // exactly as the setting reads).
    const inspect = await this.runDocker(["image", "inspect", imageTag]);
    if (inspect.code === 0) {
      onProgress?.(`Using local image ${imageTag}`);
      return;
    }
    // Second: broaden the local search. `docker image inspect feynman-server`
    // implicitly looks for `feynman-server:latest`; if the user built the
    // image with a different tag (e.g. `feynman-server:dev`) the inspect
    // misses it. `docker images --filter reference=<tag>` matches any tag
    // under that repository name, which lets us reuse a locally-built image
    // even when the tag doesn't match exactly.
    const list = await this.runDocker([
      "images",
      "--filter",
      `reference=${imageTag}`,
      "--format",
      "{{.Repository}}:{{.Tag}}",
    ]);
    if (list.code === 0) {
      const first = list.stdout
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0 && l !== "<none>:<none>");
      if (first !== undefined) {
        onProgress?.(`Using local image ${first}`);
        return;
      }
    }
    // Third: actually try to pull from a registry.
    const res = await this.runDocker(["pull", imageTag], {}, onProgress);
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
    await this.runDocker(["rm", "-f", containerName]);

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
      // alphaXiv login callback. The OAuth flow registers a fixed redirect
      // URI of `http://127.0.0.1:9876/callback`, so the container's port
      // 9876 must be reachable at the host's 127.0.0.1:9876 for the
      // browser-side redirect to land. Loopback-only — never exposed to
      // the network.
      "-p",
      "127.0.0.1:9876:9876",
      // Persist OAuth credentials across container recreations. Without these
      // mounts the container's writable layer is discarded every time we run
      // `docker rm -f` / `docker run -d` (which the plugin does on every
      // Restart Container), so the user's model-OAuth tokens at
      // `~/.feynman/agent/auth.json` and alphaXiv tokens at
      // `~/.ahub/auth.json` would silently vanish.
      //
      // Named volumes (no host path) are docker-managed: auto-created on
      // first run, survive `rm`, never grow inside the user's vault. To
      // wipe all stored credentials the user can `docker volume rm
      // feynman-state feynman-ahub` from the host.
      "-v",
      "feynman-state:/root/.feynman",
      "-v",
      "feynman-ahub:/root/.ahub",
    ];
    if (prefs.vaultMountSrc.length > 0) {
      const dst = prefs.vaultMountDst || "/vault";
      args.push("-v", `${prefs.vaultMountSrc}:${dst}`);
    }
    args.push(prefs.imageTag);

    const res = await this.runDocker(args);
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
    await this.runDocker(["stop", name]);
    await this.runDocker(["rm", name]);
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
      inspect = await this.runDocker([
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
