// Type-only preferences for the Docker supervisor. See §6.1.
//
// Consumed by `DockerSupervisor.start(prefs, envFilePath)`. The supervisor
// owns the env-file write; Agent 4 (Security) plugs the bearer-token
// generation into the same file.

export interface DockerPrefs {
  /** Image reference, e.g. `feynman/server:1.0.0`. */
  imageTag: string;
  /**
   * Host port the container binds to. The supervisor auto-bumps within
   * a 10-port window if this one is occupied; the returned `port` from
   * `start()` is authoritative.
   */
  hostPort: number;
  /**
   * Container name. The supervisor `docker rm -f`s any pre-existing
   * container with this name before `docker run -d`. Default applied by
   * caller (e.g. `feynman-server`).
   */
  containerName: string;
  /**
   * Absolute host path bind-mounted into the container. Defaults to the
   * Obsidian vault root when caller supplies it.
   */
  vaultMountSrc: string;
  /** Container-side mount target. Default `/vault`. */
  vaultMountDst: string;
  /**
   * Random 32-byte hex bearer token. Agent 4 fills this on first start;
   * the supervisor writes it into the env-file. Empty string is treated
   * as "not yet generated" — the supervisor will not start without one
   * once Agent 4 lands. For now (Wave 1) start tolerates empty token.
   */
  authToken: string;
}
