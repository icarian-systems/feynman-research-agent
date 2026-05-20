// Type-only preferences for the Docker supervisor. See §6.1.

export interface DockerPrefs {
  imageTag: string;
  hostPort: number;
  vaultPath: string;
  authToken: string;
}
