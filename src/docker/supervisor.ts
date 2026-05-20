// Docker supervisor — Local Docker mode only. See docs/ARCHITECTURE.md §6.1.
//
// First-run flow:
//   1. check() — `docker --version`.
//   2. pull(image) — pulls ghcr.io/<org>/feynman-server:<tag>.
//   3. start(opts) — `docker run -d --name feynman-server-<vaultId> …`.
//   4. status() — `docker inspect` parsed into a small state shape.
//   5. stop() — `docker stop` + `docker rm`.
//   6. pullLatest() — compare `manifest.version` to latest published tag.
//
// Stub: every method throws. Loaded only when settings.mode === "docker".

import type { DockerPrefs } from "./prefs";

export interface DockerSupervisorOptions {
  containerName: string; // e.g. `feynman-server-<vaultId>`
  image: string; // e.g. `ghcr.io/<org>/feynman-server:<tag>`
}

export interface DockerStatus {
  // TODO: pin this once we know what `docker inspect` fields we surface.
  running: boolean;
  containerId?: string;
  imageTag?: string;
}

export class DockerSupervisor {
  private readonly containerName: string;
  private readonly image: string;

  constructor(opts: DockerSupervisorOptions) {
    this.containerName = opts.containerName;
    this.image = opts.image;
  }

  async check(): Promise<void> {
    throw new Error("not implemented");
  }

  async pull(_image: string): Promise<void> {
    throw new Error("not implemented");
  }

  async start(_opts: DockerPrefs): Promise<void> {
    throw new Error("not implemented");
  }

  async stop(): Promise<void> {
    throw new Error("not implemented");
  }

  async status(): Promise<DockerStatus> {
    throw new Error("not implemented");
  }

  async pullLatest(): Promise<void> {
    throw new Error("not implemented");
  }
}
