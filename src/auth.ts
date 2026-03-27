/**
 * Track-It token management.
 *
 * Track-It uses OAuth2 password grant to /token.
 * Username format: GROUP\DOMAIN\username  (backslashes, not forward slashes)
 * Tokens expire ~1800s; we invalidate 120s early.
 * Refresh tokens work despite not being documented in Swagger.
 */

import * as https from "https";
import * as http from "http";

interface TokenEntry {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
}

// In-memory cache keyed by lowercased username
const tokenCache = new Map<string, TokenEntry>();

const TTL_BUFFER_MS = 120_000; // invalidate 2 min before expiry

function getConfig() {
  const baseUrl = process.env.TRACKIT_BASE_URL;
  const group = process.env.TRACKIT_GROUP;
  const domain = process.env.TRACKIT_DOMAIN || ""; // optional — omit for non-Windows auth
  const username = process.env.TRACKIT_USERNAME;
  const password = process.env.TRACKIT_PASSWORD;

  if (!baseUrl || !group || !username || !password) {
    throw new Error(
      "Missing required environment variables: TRACKIT_BASE_URL, TRACKIT_GROUP, TRACKIT_USERNAME, TRACKIT_PASSWORD"
    );
  }

  return { baseUrl, group, domain, username, password };
}

function postForm(url: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function fetchToken(
  baseUrl: string,
  formBody: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const tokenUrl = `${baseUrl}/token`;
  const raw = await postForm(tokenUrl, formBody);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Track-It /token returned non-JSON: ${raw}`);
  }
  if (!parsed.access_token) {
    throw new Error(`Track-It auth failed: ${raw}`);
  }
  return {
    accessToken: parsed.access_token as string,
    refreshToken: (parsed.refresh_token as string) || "",
    expiresIn: typeof parsed.expires_in === "number" ? parsed.expires_in : 1799,
  };
}

export async function getAccessToken(): Promise<string> {
  const { baseUrl, group, domain, username, password } = getConfig();
  const cacheKey = username.toLowerCase();

  const cached = tokenCache.get(cacheKey);
  const now = Date.now();

  if (cached && now < cached.expiresAt - TTL_BUFFER_MS) {
    return cached.accessToken;
  }

  // Try refresh token first if we have one
  if (cached && cached.refreshToken) {
    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: cached.refreshToken,
      }).toString();
      const result = await fetchToken(baseUrl, body);
      const entry: TokenEntry = {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken || cached.refreshToken,
        expiresAt: now + result.expiresIn * 1000,
      };
      tokenCache.set(cacheKey, entry);
      return entry.accessToken;
    } catch {
      // Refresh failed — fall through to password grant
      tokenCache.delete(cacheKey);
    }
  }

  // Full password grant
  // Username format: GROUP\DOMAIN\username  (Windows auth)
  //              or: GROUP\username          (non-Windows auth, no domain)
  const fullUsername = domain
    ? `${group}\\${domain}\\${username}`
    : `${group}\\${username}`;
  const body = new URLSearchParams({
    grant_type: "password",
    username: fullUsername,
    password,
  }).toString();
  const result = await fetchToken(baseUrl, body);
  const entry: TokenEntry = {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: now + result.expiresIn * 1000,
  };
  tokenCache.set(cacheKey, entry);
  return entry.accessToken;
}

/** Call this on a 401 response so the next call re-authenticates. */
export function invalidateToken(): void {
  const { username } = getConfig();
  tokenCache.delete(username.toLowerCase());
}
