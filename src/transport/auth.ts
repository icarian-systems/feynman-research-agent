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
