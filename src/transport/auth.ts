// Auth header construction for the transport client.
//
// Local Docker (§6.1): random bearer token generated at container start.
// Self-hosted (§6.2): optional bearer token from settings.
// Managed Modal (§6.3): Lemon Squeezy license key as the bearer.
//
// Returns `{}` when the token is null/empty so callers can spread the result
// into a header bag without conditional logic.

export function bearerHeaders(token: string | null): Record<string, string> {
  if (token === null || token.length === 0) {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}

/**
 * Identifies the plugin build to the server on every request, used for
 * server-side telemetry and version-skew diagnostics. The contract is
 * documented in `docs/SETUP.md`; the server may emit a deprecation banner or
 * 426 Upgrade Required when an unsupported client version is observed.
 */
export function clientHeaders(version: string): Record<string, string> {
  return { "X-Feynman-Client": `obsidian-plugin/${version}` };
}
