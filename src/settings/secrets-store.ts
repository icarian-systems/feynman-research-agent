// Secrets store — persists credential material outside the vault.
//
// Pre-1.0 builds wrote the Anthropic key, bearer token, provider keys and
// license key into `<vault>/.obsidian/plugins/feynman-research-agent/data.json` alongside
// non-secret settings. Because the Docker container bind-mounts the vault,
// the agent process running inside the container could read its own auth
// file with one syscall. Moving secrets to `~/.feynman/secrets.json` (mode
// 0600, outside the bind mount) closes that path.
//
// The in-memory `FeynmanSettings` shape is unchanged — callers still read
// `settings.docker.authToken` etc. Only persistence is split: data.json
// holds the non-secret shape, secrets.json holds the credentials.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { FeynmanSettings } from "./settings-tab";

export interface FeynmanSecrets {
  docker: {
    authToken: string;
    apiKeys: { anthropic?: string };
  };
  providerKeys: {
    openai?: string;
    exa?: string;
    perplexity?: string;
    gemini?: string;
  };
  selfHosted: { bearerToken: string };
  modal: { licenseKey: string };
}

export function defaultSecretsPath(): string {
  return join(homedir(), ".feynman", "secrets.json");
}

function emptySecrets(): FeynmanSecrets {
  return {
    docker: { authToken: "", apiKeys: {} },
    providerKeys: {},
    selfHosted: { bearerToken: "" },
    modal: { licenseKey: "" },
  };
}

export async function loadSecrets(path = defaultSecretsPath()): Promise<FeynmanSecrets> {
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch {
    return emptySecrets();
  }
  let parsed: Partial<FeynmanSecrets>;
  try {
    parsed = JSON.parse(body) as Partial<FeynmanSecrets>;
  } catch {
    return emptySecrets();
  }
  return mergeSecrets(emptySecrets(), parsed);
}

// Write atomically: create with mode 0600 at <path>.tmp, fsync, rename. The
// rename is atomic on POSIX and good-enough on win32 (NTFS per-user ACL is
// already restrictive; the umask race that 0o600 closes is POSIX-only).
export async function saveSecrets(
  secrets: FeynmanSecrets,
  path = defaultSecretsPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  const body = JSON.stringify(secrets, null, 2);
  await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

export function extractSecrets(s: Partial<FeynmanSettings>): FeynmanSecrets {
  const out = emptySecrets();
  if (typeof s.docker?.authToken === "string") {
    out.docker.authToken = s.docker.authToken;
  }
  if (typeof s.docker?.apiKeys?.anthropic === "string" && s.docker.apiKeys.anthropic.length > 0) {
    out.docker.apiKeys.anthropic = s.docker.apiKeys.anthropic;
  }
  for (const k of ["openai", "exa", "perplexity", "gemini"] as const) {
    const v = s.providerKeys?.[k];
    if (typeof v === "string" && v.length > 0) {
      out.providerKeys[k] = v;
    }
  }
  if (typeof s.selfHosted?.bearerToken === "string") {
    out.selfHosted.bearerToken = s.selfHosted.bearerToken;
  }
  if (typeof s.modal?.licenseKey === "string") {
    out.modal.licenseKey = s.modal.licenseKey;
  }
  return out;
}

export function containsAnySecret(s: Partial<FeynmanSettings>): boolean {
  if (typeof s.docker?.authToken === "string" && s.docker.authToken.length > 0) return true;
  if (typeof s.docker?.apiKeys?.anthropic === "string" && s.docker.apiKeys.anthropic.length > 0) return true;
  for (const k of ["openai", "exa", "perplexity", "gemini"] as const) {
    const v = s.providerKeys?.[k];
    if (typeof v === "string" && v.length > 0) return true;
  }
  if (typeof s.selfHosted?.bearerToken === "string" && s.selfHosted.bearerToken.length > 0) return true;
  if (typeof s.modal?.licenseKey === "string" && s.modal.licenseKey.length > 0) return true;
  return false;
}

// Return a clone of `s` with secret-shaped fields stripped, ready for
// persistence to data.json. The in-memory settings object retains the values.
export function withoutSecrets(s: FeynmanSettings): FeynmanSettings {
  const cloned = JSON.parse(JSON.stringify(s)) as FeynmanSettings;
  cloned.docker.authToken = "";
  delete cloned.docker.apiKeys.anthropic;
  delete cloned.providerKeys.openai;
  delete cloned.providerKeys.exa;
  delete cloned.providerKeys.perplexity;
  delete cloned.providerKeys.gemini;
  cloned.selfHosted.bearerToken = "";
  cloned.modal.licenseKey = "";
  return cloned;
}

export function applySecrets(s: FeynmanSettings, secrets: FeynmanSecrets): void {
  if (secrets.docker.authToken.length > 0) {
    s.docker.authToken = secrets.docker.authToken;
  }
  if (secrets.docker.apiKeys.anthropic !== undefined) {
    s.docker.apiKeys.anthropic = secrets.docker.apiKeys.anthropic;
  }
  for (const k of ["openai", "exa", "perplexity", "gemini"] as const) {
    if (secrets.providerKeys[k] !== undefined) {
      s.providerKeys[k] = secrets.providerKeys[k];
    }
  }
  if (secrets.selfHosted.bearerToken.length > 0) {
    s.selfHosted.bearerToken = secrets.selfHosted.bearerToken;
  }
  if (secrets.modal.licenseKey.length > 0) {
    s.modal.licenseKey = secrets.modal.licenseKey;
  }
}

function mergeSecrets(defaults: FeynmanSecrets, persisted: Partial<FeynmanSecrets>): FeynmanSecrets {
  return {
    docker: {
      authToken: persisted.docker?.authToken ?? defaults.docker.authToken,
      apiKeys: {
        anthropic: persisted.docker?.apiKeys?.anthropic ?? defaults.docker.apiKeys.anthropic,
      },
    },
    providerKeys: {
      openai: persisted.providerKeys?.openai ?? defaults.providerKeys.openai,
      exa: persisted.providerKeys?.exa ?? defaults.providerKeys.exa,
      perplexity: persisted.providerKeys?.perplexity ?? defaults.providerKeys.perplexity,
      gemini: persisted.providerKeys?.gemini ?? defaults.providerKeys.gemini,
    },
    selfHosted: {
      bearerToken: persisted.selfHosted?.bearerToken ?? defaults.selfHosted.bearerToken,
    },
    modal: {
      licenseKey: persisted.modal?.licenseKey ?? defaults.modal.licenseKey,
    },
  };
}
