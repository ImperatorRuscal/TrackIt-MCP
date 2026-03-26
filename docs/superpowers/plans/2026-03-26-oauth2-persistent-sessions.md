# OAuth2 Authorization Code Flow + Encrypted Persistent Sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full OAuth 2.0 Authorization Code Flow with PKCE to TrackIt-MCP so MCP clients (Claude Desktop, Claude Code) can authenticate users via an HTML login form, issue long-lived session tokens that survive server restarts, and refresh Track-It bearer tokens just-in-time — while preserving backward compatibility with the existing Basic/Bearer base64 auth.

**Architecture:** Three new files are introduced (`src/token-store.ts`, `src/oauth.ts`, `src/views/login.html`) plus targeted edits to `src/auth.ts` and `src/server.ts`. The token store encrypts all session data at rest using AES-256-GCM and writes atomically to disk. The OAuth router handles DCR, PKCE authorize/token flows. `src/auth.ts` gains a `getTrackItTokenForSession()` function that does just-in-time refresh using the stored `refresh_token`. `src/server.ts` wires it together and detects whether an incoming credential is a legacy base64 string or a long-lived OAuth UUID.

**Tech Stack:** Node.js 20+, TypeScript, Express 4, `crypto` (built-in — AES-256-GCM, scrypt, SHA-256), `axios` (existing), no new runtime dependencies.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| **Create** | `src/token-store.ts` | AES-256-GCM encrypted persistent store; load/save/prune; `TokenRecord` shape |
| **Create** | `src/oauth.ts` | Express router: `GET/POST /authorize`, `POST /token`, `POST /register`, DCR; also exports `buildGetToken()` factory |
| **Create** | `src/views/login.html` | Static HTML login form (Group, Domain, Username, Password) |
| **Modify** | `src/auth.ts` | Add `getTrackItTokenForSession()` — JIT refresh using stored `refresh_token`; keep existing exports unchanged |
| **Modify** | `src/server.ts` | Mount OAuth router; detect OAuth token vs legacy creds on `/mcp`; pass `tokenStore` to session factory |
| **Modify** | `.env.example` | Add `TOKEN_STORE_SECRET`, `MCP_SERVER_URL`, `OUR_TOKEN_TTL_MS` |

---

## Background: How Track-It Auth Works

Track-It's `/WebApi/token` accepts `grant_type=password` with `username` (format: `GROUP\DOMAIN\user`) and `password`. It returns:
```json
{ "access_token": "...", "token_type": "bearer", "expires_in": 1799, "refresh_token": "..." }
```

Our OAuth token (UUID) is issued by *our* server. It maps to a `TokenRecord` in the encrypted store:
```ts
interface TokenRecord {
  ourToken: string;          // UUID — what we give to the MCP client
  username: string;          // GROUP\DOMAIN\user (for display/logging only)
  trackItAccessToken: string;
  trackItRefreshToken: string;
  trackItExpiresAt: number;  // Date.now() + expires_in * 1000
  issuedAt: number;
  expiresAt: number;         // ourToken expiry (configurable, default 90 days)
}
```

> **Security note:** The password is **not** stored. JIT refresh uses only the Track-It `refresh_token`. If the refresh_token ever expires (rare — Track-It issues long-lived refresh tokens), the user re-authenticates via the HTML login form. Omitting the password minimises blast radius if the store file is ever exposed.

JIT refresh: before each tool call, if `trackItExpiresAt - Date.now() < 60_000`, call `/token` with `grant_type=refresh_token`, update the record.

---

## Task 1: Encrypted Persistent Token Store (`src/token-store.ts`)

**Files:**
- Create: `src/token-store.ts`

The store encrypts the entire token array as a single AES-256-GCM blob. The encryption key is derived once via `scryptSync(secret, salt, 32)` where `salt` is the fixed string `"trackit-mcp-store"`. On each write, a fresh random IV is used; the file format is `<iv-hex>:<authTag-hex>:<ciphertext-hex>`. Writes are atomic (write to `.tmp`, then `rename`).

- [ ] **Step 1: Create `src/token-store.ts` with full implementation**

```typescript
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export interface TokenRecord {
  ourToken: string;
  username: string;          // for display/logging only — password is NOT stored
  trackItAccessToken: string;
  trackItRefreshToken: string;
  trackItExpiresAt: number;
  issuedAt: number;
  expiresAt: number;
}

const STORE_FILE = join(process.cwd(), "data", "token-store.enc");
const TMP_FILE = STORE_FILE + ".tmp";
const SALT = "trackit-mcp-store";
const ALGORITHM = "aes-256-gcm";

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, SALT, 32) as Buffer;
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decrypt(data: string, key: Buffer): string {
  const [ivHex, authTagHex, ciphertextHex] = data.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export class TokenStore {
  private key: Buffer;
  private records: Map<string, TokenRecord> = new Map();

  constructor(secret: string) {
    this.key = deriveKey(secret);
    this.load();
  }

  private load(): void {
    if (!existsSync(STORE_FILE)) return;
    try {
      const raw = readFileSync(STORE_FILE, "utf8").trim();
      const plaintext = decrypt(raw, this.key);
      const arr: TokenRecord[] = JSON.parse(plaintext);
      const now = Date.now();
      for (const r of arr) {
        if (r.expiresAt > now) {
          this.records.set(r.ourToken, r);
        }
      }
      console.log(`[token-store] loaded ${this.records.size} active sessions`);
    } catch (err) {
      console.warn("[token-store] could not load store (first run or bad key):", (err as Error).message);
    }
  }

  private save(): void {
    mkdirSync(dirname(STORE_FILE), { recursive: true });
    const plaintext = JSON.stringify([...this.records.values()]);
    const encrypted = encrypt(plaintext, this.key);
    writeFileSync(TMP_FILE, encrypted, "utf8");
    try {
      renameSync(TMP_FILE, STORE_FILE);
    } catch (err) {
      // Windows AV/file-locking can cause EPERM on rename when the target exists.
      // Fall back to a direct overwrite — slightly less atomic but safe for our use case.
      writeFileSync(STORE_FILE, encrypted, "utf8");
      try { require("fs").unlinkSync(TMP_FILE); } catch { /* ignore */ }
      console.warn("[token-store] atomic rename failed, used direct write:", (err as Error).message);
    }
  }

  set(record: TokenRecord): void {
    this.records.set(record.ourToken, record);
    this.save();
  }

  get(ourToken: string): TokenRecord | undefined {
    return this.records.get(ourToken);
  }

  update(ourToken: string, patch: Partial<TokenRecord>): void {
    const existing = this.records.get(ourToken);
    if (!existing) throw new Error(`Token not found: ${ourToken}`);
    this.records.set(ourToken, { ...existing, ...patch });
    this.save();
  }

  delete(ourToken: string): void {
    this.records.delete(ourToken);
    this.save();
  }

  prune(): number {
    const now = Date.now();
    let count = 0;
    for (const [token, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(token);
        count++;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  size(): number {
    return this.records.size;
  }
}
```

- [ ] **Step 2: Create `data/` directory entry in `.gitignore`**

Add to `.gitignore`:
```
data/
```

- [ ] **Step 3: Verify the file compiles cleanly**

```bash
cd D:/src/TrackIt-MCP && npx tsc --noEmit
```
Expected: no errors. The Step 1 code block already has the correct static imports (`mkdirSync`, `dirname`) and the Windows-safe `save()` with try/catch fallback — use it as-is.

- [ ] **Step 4: Commit**

```bash
cd D:/src/TrackIt-MCP
git add src/token-store.ts .gitignore
git commit -m "feat: add AES-256-GCM encrypted persistent token store"
```

---

## Task 2: `.env.example` Updates

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Update `.env.example`**

Replace the entire file content with:
```
# URL of the Track-It WebAPI (no trailing slash)
TRACKIT_BASE_URL=http://awsc-trackit-02.acmenetwork.com/TrackIt/WebApi

# Port this MCP server listens on
PORT=3000

# Track-It token cache TTL in milliseconds (default: 28 minutes, slightly under Track-It's 30-min expiry)
TOKEN_TTL_MS=1680000

# Secret used to encrypt the persistent token store (change this! use a long random string)
TOKEN_STORE_SECRET=change-me-use-a-long-random-string-here

# Public URL of this MCP server (used in OAuth redirect_uri validation)
MCP_SERVER_URL=http://awsc-trackit-02.acmenetwork.com:3000

# How long our issued OAuth tokens last in milliseconds (default: 90 days)
OUR_TOKEN_TTL_MS=7776000000
```

- [ ] **Step 2: Commit**

```bash
cd D:/src/TrackIt-MCP
git add .env.example
git commit -m "chore: add OAuth env vars to .env.example"
```

---

## Task 3: HTML Login Form (`src/views/login.html`)

**Files:**
- Create: `src/views/login.html`

This is a self-contained HTML page served at `GET /authorize`. It posts back to `POST /authorize`. All OAuth state (client_id, code_challenge, code_challenge_method, redirect_uri, state) is passed as hidden fields.

- [ ] **Step 1: Create `src/views/login.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TrackIt Sign In</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #f0f2f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0;
    }
    .card {
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 2px 12px rgba(0,0,0,.12);
      padding: 2rem;
      width: 100%;
      max-width: 420px;
    }
    h1 { font-size: 1.4rem; margin: 0 0 1.5rem; color: #1a1a1a; }
    label { display: block; font-size: .85rem; font-weight: 600; color: #444; margin-bottom: .25rem; }
    .row { display: flex; gap: .75rem; }
    .row .field { flex: 1; }
    .field { margin-bottom: 1rem; }
    input[type=text], input[type=password] {
      width: 100%;
      padding: .55rem .75rem;
      border: 1px solid #d1d5db;
      border-radius: 5px;
      font-size: .95rem;
      transition: border-color .15s;
    }
    input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
    button[type=submit] {
      width: 100%;
      padding: .65rem;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 5px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      margin-top: .5rem;
    }
    button:hover { background: #1d4ed8; }
    .hint { font-size: .78rem; color: #6b7280; margin-top: 1.25rem; text-align: center; }
    .error {
      background: #fef2f2;
      border: 1px solid #fca5a5;
      border-radius: 5px;
      color: #b91c1c;
      padding: .6rem .9rem;
      font-size: .88rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in to Track-It</h1>

    {{ERROR_BLOCK}}

    <form method="POST" action="/authorize">
      <!-- OAuth PKCE state (hidden) -->
      <input type="hidden" name="client_id"             value="{{CLIENT_ID}}">
      <input type="hidden" name="redirect_uri"          value="{{REDIRECT_URI}}">
      <input type="hidden" name="state"                 value="{{STATE}}">
      <input type="hidden" name="code_challenge"        value="{{CODE_CHALLENGE}}">
      <input type="hidden" name="code_challenge_method" value="{{CODE_CHALLENGE_METHOD}}">

      <div class="row">
        <div class="field">
          <label for="group">Track-It Group</label>
          <input type="text" id="group" name="group" placeholder="HELP DESK" required autocomplete="off" value="{{GROUP}}">
        </div>
        <div class="field">
          <label for="domain">Windows Domain</label>
          <input type="text" id="domain" name="domain" placeholder="CONTOSO" required autocomplete="off" value="{{DOMAIN}}">
        </div>
      </div>

      <div class="field">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" placeholder="jsmith" required autocomplete="username" value="{{USERNAME}}">
      </div>

      <div class="field">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autocomplete="current-password">
      </div>

      <button type="submit">Sign In</button>
    </form>

    <p class="hint">Your credentials are used only to authenticate with Track-It.<br>All actions are attributed to your account.</p>
  </div>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
cd D:/src/TrackIt-MCP
git add src/views/login.html
git commit -m "feat: add HTML login form for OAuth authorize flow"
```

---

## Task 4: OAuth Router (`src/oauth.ts`)

**Files:**
- Create: `src/oauth.ts`

This file exports:
1. `createOAuthRouter(tokenStore, getTrackItToken)` — Express Router with all OAuth endpoints
2. A `pendingCodes` Map (in-memory, short-lived) for auth codes with 60s TTL

**OAuth endpoints:**
- `POST /register` — Dynamic Client Registration (DCR). Returns a `client_id`. We generate a UUID and accept any `redirect_uris`. No client secret needed (PKCE-only).
- `GET /authorize` — Show login form (reads query params: `client_id`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method`). Validates `code_challenge_method=S256`.
- `POST /authorize` — Receive form POST. Authenticate against Track-It. On success: generate auth code, store in `pendingCodes`, redirect to `redirect_uri?code=...&state=...`.
- `POST /token` — Exchange auth code for our long-lived token. Verify PKCE (`S256(code_verifier) == code_challenge`). Issue UUID token, store in TokenStore, return as `access_token`.

```typescript
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
  router.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
    const base = process.env.MCP_SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
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
    const redirectUrl = new URL(redirect_uri);
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
```

- [ ] **Step 1: Create `src/oauth.ts` with the code above**

- [ ] **Step 2: Verify it compiles**

```bash
cd D:/src/TrackIt-MCP && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd D:/src/TrackIt-MCP
git add src/oauth.ts
git commit -m "feat: OAuth2 authorization code flow with PKCE (router + login handler)"
```

---

## Task 5: JIT Refresh in `src/auth.ts`

**Files:**
- Modify: `src/auth.ts`

Add a new exported function `getTrackItTokenForSession(tokenStore, ourToken)`. This is the function `server.ts` will call when an OAuth session needs a Track-It token. It:
1. Looks up the `TokenRecord` by `ourToken`
2. If `trackItExpiresAt - now < 60_000` (within 60s of expiry), calls Track-It's `/token` with `grant_type=refresh_token`
3. Updates the store with new Track-It tokens
4. Returns the current `trackItAccessToken`

Keep all existing exports (`parseBasicAuth`, `getBearerToken`, `invalidateToken`) unchanged.

- [ ] **Step 1: Add imports and new function to `src/auth.ts`**

At the top of `src/auth.ts`, add the `TokenStore` import after the existing `axios` import:
```typescript
import { TokenStore } from "./token-store.js";
```

At the bottom of `src/auth.ts`, append:
```typescript
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
```

- [ ] **Step 2: Verify it compiles**

```bash
cd D:/src/TrackIt-MCP && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd D:/src/TrackIt-MCP
git add src/auth.ts
git commit -m "feat: add getTrackItTokenForSession with JIT refresh_token support"
```

---

## Task 6: Wire Everything in `src/server.ts`

**Files:**
- Modify: `src/server.ts`

This is the largest change. We need to:

1. Import `TokenStore` and `createOAuthRouter` and `getTrackItTokenForSession`
2. Instantiate `tokenStore` (requires `TOKEN_STORE_SECRET` env var — validate at startup)
3. Mount the OAuth router (replaces the stub `/register` and `/.well-known/oauth-authorization-server` routes)
4. Update the `Session` interface and session creation to support two auth modes:
   - **OAuth mode**: `ourToken` is present; `getToken` calls `getTrackItTokenForSession(tokenStore, ourToken)`
   - **Legacy mode**: `creds` is present; `getToken` calls existing `getBearerToken(username, password)`
5. On `POST /mcp`: detect whether the `Authorization: Bearer` value is a UUID (our OAuth token) or a base64 string (legacy), route accordingly

**UUID detection:** A UUID v4 matches `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`. A base64-encoded credential will not match this pattern.

- [ ] **Step 1: Replace `src/server.ts` with the updated version**

```typescript
import "dotenv/config";
import { randomUUID } from "crypto";
import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { parseBasicAuth, getBearerToken, invalidateToken, getTrackItTokenForSession } from "./auth.js";
import { TokenStore } from "./token-store.js";
import { createOAuthRouter } from "./oauth.js";
import { registerTicketTools } from "./tools/tickets.js";
import { registerAssignmentTools } from "./tools/assignments.js";
import { registerSolutionTools } from "./tools/solutions.js";
import { registerMiscTools } from "./tools/misc.js";

// ---------------------------------------------------------------------------
// Validate required config at startup
// ---------------------------------------------------------------------------
if (!process.env.TRACKIT_BASE_URL) {
  console.error("ERROR: TRACKIT_BASE_URL is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}
if (!process.env.TOKEN_STORE_SECRET) {
  console.error("ERROR: TOKEN_STORE_SECRET is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT ?? "3000", 10);

const SERVER_INSTRUCTIONS =
  "This server exposes BMC Track-It 2021 ITSM operations. " +
  "Before creating tickets or assignments, call get_module_fields " +
  "(moduleSequence=1 for Tickets, 2 for Assignments) to discover available " +
  "field names. Use the search tool to find records by keyword before looking " +
  "up by ID. All write operations are attributed to the authenticated user.";

// ---------------------------------------------------------------------------
// Token store (encrypted persistent sessions)
// ---------------------------------------------------------------------------
const tokenStore = new TokenStore(process.env.TOKEN_STORE_SECRET);

// Prune expired sessions every hour
setInterval(() => {
  const pruned = tokenStore.prune();
  if (pruned > 0) console.log(`[token-store] pruned ${pruned} expired sessions`);
}, 3_600_000);

// ---------------------------------------------------------------------------
// UUID pattern — used to distinguish our OAuth tokens from legacy base64 creds
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

interface Session {
  transport: StreamableHTTPServerTransport;
  creds: { username: string; password: string } | null;
  ourToken: string | null;
}

const sessions = new Map<string, Session>();

/**
 * Build a new McpServer with all tools bound to the given getToken factory.
 * Credentials (legacy or OAuth) are captured in the closure at session-creation time.
 */
function createMcpServer(getToken: () => Promise<string>): McpServer {
  const server = new McpServer(
    { name: "trackit-mcp", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS }
  );

  registerTicketTools(server, getToken);
  registerAssignmentTools(server, getToken);
  registerSolutionTools(server, getToken);
  registerMiscTools(server, getToken);

  return server;
}

// ---------------------------------------------------------------------------
// Express server
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // needed for HTML form POST

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "trackit-mcp",
    version: "1.0.0",
    activeSessions: sessions.size,
    storedTokens: tokenStore.size(),
  });
});

// ---------------------------------------------------------------------------
// OAuth 2.0 endpoints (DCR, authorize, token, discovery)
// ---------------------------------------------------------------------------
app.use("/", createOAuthRouter(tokenStore));

// ---------------------------------------------------------------------------
// MCP endpoint
// ---------------------------------------------------------------------------
app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // --- Existing session: route request to its transport ---
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found or expired. Re-initialize the MCP connection." });
      return;
    }
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  // --- New session (initialize request) ---
  // Determine auth mode: OAuth UUID token or legacy Basic/Bearer base64 creds
  const authHeader = req.headers.authorization as string | undefined;

  let getToken: () => Promise<string>;
  let sessionCreds: { username: string; password: string } | null = null;
  let sessionOurToken: string | null = null;

  if (authHeader?.startsWith("Bearer ") && UUID_RE.test(authHeader.slice(7).trim())) {
    // OAuth mode — Bearer <our-uuid>
    const ourToken = authHeader.slice(7).trim();
    const record = tokenStore.get(ourToken);
    if (!record) {
      res.status(401).json({ error: "Invalid or expired OAuth token. Please re-authenticate." });
      return;
    }
    sessionOurToken = ourToken;
    getToken = async () => getTrackItTokenForSession(tokenStore, ourToken);
  } else {
    // Legacy mode — Basic or Bearer <base64(GROUP\DOMAIN\user:password)>
    const creds = parseBasicAuth(authHeader) ?? { username: "", password: "" };
    sessionCreds = creds;
    getToken = async () => {
      if (!creds.username) {
        throw new Error(
          "No credentials provided. Set one of the following headers on your MCP client:\n" +
            "  Authorization: Basic <base64(credentials)>\n" +
            "  Authorization: Bearer <base64(credentials)>  (for API-key-style clients)\n" +
            "Credential format: 'TRACK-IT GROUP\\DOMAIN\\username:password'\n" +
            "Example:           'HELP DESK\\CONTOSO\\jsmith:password'"
        );
      }
      try {
        return await getBearerToken(creds.username, creds.password);
      } catch (err: unknown) {
        invalidateToken(creds.username);
        const msg = err instanceof Error ? err.message : "Unknown authentication error";
        throw new Error(`Track-It authentication failed for '${creds.username}': ${msg}`);
      }
    };
  }

  let assignedSessionId: string | undefined;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => {
      assignedSessionId = randomUUID();
      return assignedSessionId;
    },
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, creds: sessionCreds, ourToken: sessionOurToken });
      const user = sessionOurToken
        ? `OAuth:${tokenStore.get(sessionOurToken)?.username ?? "unknown"}`
        : (sessionCreds?.username || "(anonymous)");
      console.log(`[session] created ${id} for user '${user}' — total sessions: ${sessions.size}`);
    },
  });

  transport.onclose = () => {
    if (assignedSessionId) {
      sessions.delete(assignedSessionId);
      console.log(`[session] closed ${assignedSessionId} — total sessions: ${sessions.size}`);
    }
  };

  const server = createMcpServer(getToken);
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Reject non-POST on /mcp
app.all("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method Not Allowed. Use POST." });
});

// JSON catch-all — prevents HTML 404s from breaking the MCP client's JSON parsers
app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

app.listen(PORT, () => {
  console.log(`trackit-mcp listening on http://0.0.0.0:${PORT}`);
  console.log(`  MCP endpoint:  http://0.0.0.0:${PORT}/mcp`);
  console.log(`  Health check:  http://0.0.0.0:${PORT}/health`);
  console.log(`  OAuth login:   http://0.0.0.0:${PORT}/authorize`);
  console.log(`  Track-It API:  ${process.env.TRACKIT_BASE_URL}`);
});
```

- [ ] **Step 2: Verify it compiles**

```bash
cd D:/src/TrackIt-MCP && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Build and do a smoke test**

```bash
cd D:/src/TrackIt-MCP && npm run build
```
Expected: `dist/server.js` created with no TypeScript errors.

Then verify `TOKEN_STORE_SECRET` is set in your `.env`:
```bash
# In your .env file, add:
TOKEN_STORE_SECRET=my-dev-secret-change-in-prod
MCP_SERVER_URL=http://localhost:3000
OUR_TOKEN_TTL_MS=7776000000
```

Start the server and check health:
```bash
npm run dev
# In another terminal:
curl http://localhost:3000/health
```
Expected:
```json
{"status":"ok","server":"trackit-mcp","version":"1.0.0","activeSessions":0,"storedTokens":0}
```

- [ ] **Step 4: Verify OAuth discovery endpoint**

```bash
curl http://localhost:3000/.well-known/oauth-authorization-server
```
Expected: JSON with `authorization_endpoint`, `token_endpoint`, `registration_endpoint`.

- [ ] **Step 5: Verify login form renders**

Open in browser: `http://localhost:3000/authorize?response_type=code&client_id=test&redirect_uri=http://localhost:3000/callback&state=xyz&code_challenge=abc123&code_challenge_method=S256`

Expected: HTML login form with Group, Domain, Username, Password fields.

- [ ] **Step 6: Commit**

```bash
cd D:/src/TrackIt-MCP
git add src/server.ts
git commit -m "feat: wire OAuth2 router and dual-mode auth (OAuth UUID + legacy Basic/Bearer)"
```

---

## Task 7: README Update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add OAuth2 section to README after "Connecting MCP Clients"**

In `README.md`, after the existing `## Connecting MCP Clients` section, insert a new section:

```markdown
### OAuth 2.0 Flow (Claude Desktop / MCP clients with OAuth support)

MCP clients that support OAuth 2.0 (e.g. Claude Desktop with the standard connector) will automatically:

1. Discover the OAuth server at `/.well-known/oauth-authorization-server`
2. Register a client at `POST /register` (DCR)
3. Redirect the user to `GET /authorize` — an HTML login form asking for Track-It credentials
4. POST credentials back; the server authenticates against Track-It and issues a short-lived auth code
5. Exchange the auth code for a long-lived UUID token at `POST /token`
6. Store the UUID token and use it for all subsequent MCP requests

**Long-lived sessions:** The issued token is valid for 90 days (configurable via `OUR_TOKEN_TTL_MS`). The server silently refreshes the underlying Track-It token using `refresh_token` whenever it's within 60 seconds of expiry — users are never prompted to re-authenticate during a session.

**Required `.env` additions for OAuth:**
```
TOKEN_STORE_SECRET=<long-random-string>   # encrypts the persistent token store
MCP_SERVER_URL=http://your-server:3000    # used in OAuth discovery metadata
OUR_TOKEN_TTL_MS=7776000000               # 90 days in milliseconds
```

**Adding to Claude Desktop (OAuth flow):**
1. Open Claude Desktop settings → Connectors → Add custom connector
2. Set URL to: `http://awsc-trackit-02.acmenetwork.com:3000/mcp`
3. Leave Authorization header empty — Claude Desktop will trigger the OAuth flow automatically
```

- [ ] **Step 2: Commit**

```bash
cd D:/src/TrackIt-MCP
git add README.md
git commit -m "docs: add OAuth2 flow documentation to README"
```

---

## Task 8: End-to-End Manual Test

No automated test framework is installed, so verify manually using `curl`.

- [ ] **Step 1: Generate a PKCE code_verifier and code_challenge**

```bash
# In bash (Git Bash, WSL, or Mac terminal)
CODE_VERIFIER=$(openssl rand -base64 32 | tr -d '=+/' | head -c 43)
CODE_CHALLENGE=$(echo -n "$CODE_VERIFIER" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')
echo "verifier: $CODE_VERIFIER"
echo "challenge: $CODE_CHALLENGE"
```

- [ ] **Step 2: Register a client**

```bash
curl -s -X POST http://localhost:3000/register \
  -H "Content-Type: application/json" \
  -d '{"redirect_uris":["http://localhost:9999/callback"]}' | jq .
```
Expected: `{"client_id":"<uuid>","redirect_uris":[...],...}`
Save the `client_id`.

- [ ] **Step 3: Open the login form in a browser**

```
http://localhost:3000/authorize?response_type=code&client_id=<client_id>&redirect_uri=http://localhost:9999/callback&state=teststate&code_challenge=<CODE_CHALLENGE>&code_challenge_method=S256
```
Expected: Login form renders.

- [ ] **Step 4: Submit credentials (curl simulating form POST)**

```bash
curl -v -X POST http://localhost:3000/authorize \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "client_id=<client_id>" \
  --data-urlencode "redirect_uri=http://localhost:9999/callback" \
  --data-urlencode "state=teststate" \
  --data-urlencode "code_challenge=<CODE_CHALLENGE>" \
  --data-urlencode "code_challenge_method=S256" \
  --data-urlencode "group=HELP DESK" \
  --data-urlencode "domain=CONTOSO" \
  --data-urlencode "username=jsmith" \
  --data-urlencode "password=yourpassword" 2>&1 | grep -i "location:"
```
Expected: `location: http://localhost:9999/callback?code=<uuid>&state=teststate`
(curl lowercases response header names in verbose output)
Save the `code`.

- [ ] **Step 5: Verify PKCE failure (wrong verifier is rejected)**

Get a fresh auth code by repeating Step 4 with new credentials, then try to exchange it with a wrong verifier:

```bash
curl -s -X POST http://localhost:3000/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=<new-code>" \
  --data-urlencode "redirect_uri=http://localhost:9999/callback" \
  --data-urlencode "code_verifier=WRONG_VERIFIER_VALUE_THAT_DOES_NOT_MATCH" \
  --data-urlencode "client_id=<client_id>" | jq .
```
Expected: `{"error":"invalid_grant","error_description":"PKCE verification failed"}`

- [ ] **Step 6: Exchange real auth code for token**

```bash
curl -s -X POST http://localhost:3000/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=<code>" \
  --data-urlencode "redirect_uri=http://localhost:9999/callback" \
  --data-urlencode "code_verifier=<CODE_VERIFIER>" \
  --data-urlencode "client_id=<client_id>" | jq .
```
Expected: `{"access_token":"<uuid>","token_type":"bearer","expires_in":7776000}`

- [ ] **Step 7: Verify health shows stored token**

```bash
curl http://localhost:3000/health
```
Expected: `"storedTokens":1`

- [ ] **Step 8: Use the OAuth token with the MCP endpoint (initialize)**

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}},"id":1}' | jq .
```
Expected: JSON-RPC response with `result.serverInfo.name = "trackit-mcp"`.

- [ ] **Step 9: Verify backward compat — legacy Basic Auth still works**

```bash
B64=$(echo -n 'HELP DESK\CONTOSO\jsmith:yourpassword' | base64)
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $B64" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}},"id":1}' | jq .
```
Expected: Same successful initialize response.

- [ ] **Step 10: Restart server and verify OAuth token persists**

```bash
# Stop dev server (Ctrl+C), restart:
npm run dev
# Check health again:
curl http://localhost:3000/health
```
Expected: `"storedTokens":1` — token survived restart.

- [ ] **Step 11: Final commit**

```bash
cd D:/src/TrackIt-MCP
git tag v1.1.0
git log --oneline -8
```

---

## Summary of All New / Changed Files

| File | Change |
|------|--------|
| `src/token-store.ts` | **New** — AES-256-GCM encrypted store |
| `src/oauth.ts` | **New** — OAuth2 router (DCR, authorize, token) |
| `src/views/login.html` | **New** — HTML login form |
| `src/auth.ts` | **Additive** — `getTrackItTokenForSession()` + import |
| `src/server.ts` | **Replaced** — mounts OAuth router, dual-mode auth |
| `.env.example` | **Updated** — three new env vars |
| `README.md` | **Updated** — OAuth2 section |
| `.gitignore` | **Updated** — `data/` directory |

## Rollback

All changes are additive or backward-compatible. Legacy clients using `Authorization: Basic` or `Authorization: Bearer <base64>` continue to work unchanged. To disable OAuth entirely, simply don't set `TOKEN_STORE_SECRET` (server will refuse to start — which is a clear signal, not a silent failure).
