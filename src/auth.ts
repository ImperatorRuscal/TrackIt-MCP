import axios from "axios";
import { TokenStore } from "./token-store.js";

const TRACKIT_BASE_URL = process.env.TRACKIT_BASE_URL!;
const TOKEN_TTL_MS = parseInt(process.env.TOKEN_TTL_MS ?? "1680000", 10); // 28 min default

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Keyed by lowercase full username string ("group\domain\user") to survive case variations
const tokenCache = new Map<string, CachedToken>();

/**
 * Parse credentials from an Authorization header.
 *
 * Accepts two forms — both expect the same base64-encoded payload:
 *   Basic  <base64("GROUP\DOMAIN\user:password")>   — standard HTTP Basic Auth
 *   Bearer <base64("GROUP\DOMAIN\user:password")>   — for clients that only
 *                                                      support API-key / Bearer
 *                                                      style configuration
 *
 * Returns null if the header is missing, uses an unsupported scheme, or the
 * decoded value does not contain a colon separator.
 */
export function parseBasicAuth(
  authHeader: string | undefined
): { username: string; password: string } | null {
  if (!authHeader) return null;

  let b64: string;
  if (authHeader.startsWith("Basic ")) {
    b64 = authHeader.slice(6);
  } else if (authHeader.startsWith("Bearer ")) {
    b64 = authHeader.slice(7);
  } else {
    return null;
  }

  const decoded = Buffer.from(b64.trim(), "base64").toString("utf8");
  const colonIndex = decoded.indexOf(":");
  if (colonIndex === -1) return null;
  return {
    username: decoded.slice(0, colonIndex),
    password: decoded.slice(colonIndex + 1),
  };
}

/**
 * Get a valid Track-It bearer token for the given credentials.
 * Returns a cached token if one exists and has not expired; otherwise
 * authenticates against Track-It's /token endpoint and caches the result.
 *
 * Throws if authentication fails.
 */
export async function getBearerToken(
  username: string,
  password: string
): Promise<string> {
  const cacheKey = username.toLowerCase();
  const cached = tokenCache.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  // Exchange credentials for a bearer token
  const params = new URLSearchParams();
  params.set("grant_type", "password");
  params.set("username", username); // Track-It requires exact case: "GROUP\DOMAIN\user"
  params.set("password", password);

  const response = await axios.post(`${TRACKIT_BASE_URL}/token`, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    validateStatus: (s) => s === 200,
  });

  const token: string = response.data.access_token;
  tokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });

  return token;
}

/**
 * Remove a user's cached token (e.g. after receiving a 401 from Track-It).
 * The next call to getBearerToken will re-authenticate.
 */
export function invalidateToken(username: string): void {
  tokenCache.delete(username.toLowerCase());
}

/**
 * Get a valid Track-It access token for an OAuth session managed by our TokenStore.
 *
 * Uses the stored refresh_token to silently renew the Track-It session when it
 * is within 60 seconds of expiry. Throws if the token record is not found or
 * if refresh fails (caller should surface the error to the MCP client).
 */
export async function getTrackItTokenForSession(
  tokenStore: TokenStore,
  ourToken: string
): Promise<string> {
  const record = tokenStore.get(ourToken);
  if (!record) {
    throw new Error("Session not found. Please re-authenticate via the MCP client.");
  }

  const REFRESH_THRESHOLD_MS = 60_000;
  if (Date.now() < record.trackItExpiresAt - REFRESH_THRESHOLD_MS) {
    // Token is still fresh — return it directly
    return record.trackItAccessToken;
  }

  // Token is stale (or about to expire) — refresh it
  try {
    const params = new URLSearchParams();
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", record.trackItRefreshToken);
    const response = await axios.post(`${TRACKIT_BASE_URL}/token`, params, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      validateStatus: (s) => s === 200,
    });

    const newAccess: string = response.data.access_token;
    const newRefresh: string = response.data.refresh_token ?? record.trackItRefreshToken;
    const expiresIn: number = response.data.expires_in ?? 1799;

    tokenStore.update(ourToken, {
      trackItAccessToken: newAccess,
      trackItRefreshToken: newRefresh,
      trackItExpiresAt: Date.now() + expiresIn * 1000,
    });

    return newAccess;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    throw new Error(`Track-It token refresh failed for '${record.username}': ${msg}`);
  }
}
