// src/oauth.ts
import { Router, Request, Response } from "express";
import { randomUUID, createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import axios from "axios";
import { TokenStore, TokenRecord } from "./token-store.js";

const TRACKIT_BASE_URL = process.env.TRACKIT_BASE_URL!;
const OUR_TOKEN_TTL_MS = parseInt(process.env.OUR_TOKEN_TTL_MS ?? "7776000000", 10); // 90 days
const LOGIN_TEMPLATE = readFileSync(join(process.cwd(), "src/views/login.html"), "utf8");

// ---------------------------------------------------------------------------
// In-memory: registered clients and pending auth codes (not persisted —
// these are short-lived; clients re-register on reconnect which is fine)
// ---------------------------------------------------------------------------

interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
}

interface PendingCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  username: string;          // password is NOT stored here — only Track-It tokens
  trackItAccessToken: string;
  trackItRefreshToken: string;
  trackItExpiresAt: number;
  expiresAt: number;
}

const registeredClients = new Map<string, RegisteredClient>();
const pendingCodes = new Map<string, PendingCode>();

// Prune expired codes every minute
setInterval(() => {
  const now = Date.now();
  for (const [code, pending] of pendingCodes) {
    if (pending.expiresAt <= now) pendingCodes.delete(code);
  }
}, 60_000);

// ---------------------------------------------------------------------------
// PKCE helper
// ---------------------------------------------------------------------------
function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ---------------------------------------------------------------------------
// Template renderer
// ---------------------------------------------------------------------------
function renderLogin(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  error?: string;
  group?: string;
  domain?: string;
  username?: string;
}): string {
  const errorBlock = params.error
    ? `<div class="error">${params.error.replace(/</g, "&lt;")}</div>`
    : "";

  return LOGIN_TEMPLATE
    .replace("{{ERROR_BLOCK}}", errorBlock)
    .replace("{{CLIENT_ID}}", params.clientId)
    .replace("{{REDIRECT_URI}}", params.redirectUri)
    .replace("{{STATE}}", params.state)
    .replace("{{CODE_CHALLENGE}}", params.codeChallenge)
    .replace("{{CODE_CHALLENGE_METHOD}}", params.codeChallengeMethod)
    .replace("{{GROUP}}", params.group ?? "")
    .replace("{{DOMAIN}}", params.domain ?? "")
    .replace("{{USERNAME}}", params.username ?? "");
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
export function createOAuthRouter(tokenStore: TokenStore): Router {
  const router = Router();

  // --- Dynamic Client Registration ---
  router.post("/register", (req: Request, res: Response) => {
    const redirectUris: string[] = req.body?.redirect_uris ?? [];
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris required" });
      return;
    }
    const clientId = randomUUID();
    registeredClients.set(clientId, { clientId, redirectUris });
    res.status(201).json({
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
  });

  // --- OAuth discovery ---
  // Always returns 404. mcp-remote calls this endpoint WITHOUT forwarding the --header auth
  // value, so the conditional check on req.headers.authorization is never triggered.
  // With 404 here, mcp-remote skips OAuth entirely and forwards the --header value directly
  // on all MCP POST requests instead. Browser users reach the OAuth login at /authorize directly.
  router.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
    res.status(404).json({ error: "not_found" });
  });

  // --- GET /authorize — show login form ---
  router.get("/authorize", (req: Request, res: Response) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query as Record<string, string>;

    if (response_type !== "code") {
      res.status(400).json({ error: "unsupported_response_type" });
      return;
    }
    if (code_challenge_method !== "S256") {
      res.status(400).json({ error: "invalid_request", error_description: "Only S256 PKCE is supported" });
      return;
    }
    if (!client_id || !redirect_uri || !code_challenge) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing required parameters" });
      return;
    }

    res.send(renderLogin({ clientId: client_id, redirectUri: redirect_uri, state: state ?? "", codeChallenge: code_challenge, codeChallengeMethod: code_challenge_method }));
  });

  // --- POST /authorize — handle form submit ---
  router.post("/authorize", async (req: Request, res: Response) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, group, domain, username, password } = req.body as Record<string, string>;

    const rerender = (error: string) =>
      res.status(401).send(renderLogin({ clientId: client_id, redirectUri: redirect_uri, state: state ?? "", codeChallenge: code_challenge, codeChallengeMethod: code_challenge_method, error, group, domain, username }));

    if (!group || !domain || !username || !password) {
      return rerender("All fields are required.");
    }

    const fullUsername = `${group}\\${domain}\\${username}`;

    // Authenticate against Track-It
    let accessToken: string;
    let refreshToken: string;
    let expiresIn: number;
    try {
      const params = new URLSearchParams();
      params.set("grant_type", "password");
      params.set("username", fullUsername);
      params.set("password", password);
      const response = await axios.post(`${TRACKIT_BASE_URL}/token`, params, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        validateStatus: (s) => s === 200,
      });
      accessToken = response.data.access_token;
      refreshToken = response.data.refresh_token;
      expiresIn = response.data.expires_in ?? 1799;
    } catch {
      return rerender("Invalid credentials. Please check your Group, Domain, username, and password.");
    }

    // Issue auth code (60s TTL)
    const code = randomUUID();
    pendingCodes.set(code, {
      code,
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      username: fullUsername,
      trackItAccessToken: accessToken,
      trackItRefreshToken: refreshToken,
      trackItExpiresAt: Date.now() + expiresIn * 1000,
      expiresAt: Date.now() + 60_000,
    });

    // Redirect back to client
    let redirectUrl: URL;
    try {
      redirectUrl = new URL(redirect_uri);
    } catch {
      return rerender("Invalid redirect URI.");
    }
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);
    res.redirect(redirectUrl.toString());
  });

  // --- POST /token — exchange auth code ---
  router.post("/token", (req: Request, res: Response) => {
    const { grant_type, code, redirect_uri, code_verifier, client_id } = req.body as Record<string, string>;

    if (grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }

    const pending = pendingCodes.get(code);
    if (!pending || pending.expiresAt < Date.now()) {
      pendingCodes.delete(code);
      res.status(400).json({ error: "invalid_grant", error_description: "Authorization code expired or invalid" });
      return;
    }

    // PKCE verification
    if (s256(code_verifier) !== pending.codeChallenge) {
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }

    if (pending.redirectUri !== redirect_uri) {
      res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
      return;
    }

    pendingCodes.delete(code);

    // Issue our long-lived token
    const ourToken = randomUUID();
    const now = Date.now();
    const record: TokenRecord = {
      ourToken,
      username: pending.username,
      trackItAccessToken: pending.trackItAccessToken,
      trackItRefreshToken: pending.trackItRefreshToken,
      trackItExpiresAt: pending.trackItExpiresAt,
      issuedAt: now,
      expiresAt: now + OUR_TOKEN_TTL_MS,
    };
    tokenStore.set(record);

    const expiresInSecs = Math.floor(OUR_TOKEN_TTL_MS / 1000);
    res.json({
      access_token: ourToken,
      token_type: "bearer",
      expires_in: expiresInSecs,
    });
  });

  return router;
}
