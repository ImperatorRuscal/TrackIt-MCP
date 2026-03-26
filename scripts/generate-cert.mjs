#!/usr/bin/env node
/**
 * Generates a self-signed TLS certificate for local/development use.
 *
 * Usage:  npm run generate-cert
 *
 * Requires OpenSSL in PATH.
 *   Windows: install Git for Windows (https://git-scm.com) — bundles OpenSSL
 *   Mac/Linux: OpenSSL is pre-installed
 *
 * For production, replace the generated files with a certificate signed by
 * your internal CA (or a public CA) and point TLS_CERT_PATH / TLS_KEY_PATH
 * in .env at the new files.
 */

import { execFileSync } from "child_process";
import { mkdirSync } from "fs";
import { join } from "path";

const CERT_DIR = "certs";
const KEY_FILE = join(CERT_DIR, "server.key");
const CERT_FILE = join(CERT_DIR, "server.cert");

mkdirSync(CERT_DIR, { recursive: true });

// Detect the server hostname to include in the SAN.
// Falls back to localhost if MCP_SERVER_URL is not set.
let hostname = "localhost";
const serverUrl = process.env.MCP_SERVER_URL;
if (serverUrl) {
  try {
    hostname = new URL(serverUrl).hostname;
  } catch {
    // leave as localhost
  }
}

const subj = `/CN=${hostname}/O=TrackIt MCP/OU=Internal`;
// SAN must include both DNS name and IP for clients that enforce it
const san = `subjectAltName=DNS:${hostname},DNS:localhost,IP:127.0.0.1`;

// Use execFileSync with an argument array (not execSync with a shell string)
// to prevent shell injection from hostname/san values.
const args = [
  "req",
  "-x509",
  "-newkey", "rsa:2048",
  "-keyout", KEY_FILE,
  "-out", CERT_FILE,
  "-days", "365",
  "-nodes",
  "-subj", subj,
  "-addext", san,
];

console.log("Generating self-signed certificate...");
console.log(`  Hostname : ${hostname}`);
console.log(`  Key file : ${KEY_FILE}`);
console.log(`  Cert file: ${CERT_FILE}`);
console.log("");

try {
  execFileSync("openssl", args, { stdio: "inherit" });
} catch {
  console.error("\nFailed to run openssl. Is it installed and in your PATH?");
  console.error("  Windows: install Git for Windows — https://git-scm.com");
  console.error("  Mac:     brew install openssl");
  console.error("  Linux:   sudo apt install openssl  (or equivalent)");
  process.exit(1);
}

console.log(`
Self-signed certificate generated (valid 365 days).

Next steps
──────────
1. Add these lines to your .env file:

     TLS_KEY_PATH=certs/server.key
     TLS_CERT_PATH=certs/server.cert

2. Update MCP_SERVER_URL in .env to use https://:

     MCP_SERVER_URL=https://${hostname}:3000

3. Restart the server:  npm run dev  (or pm2 restart trackit-mcp)

For production
──────────────
Replace certs/server.key and certs/server.cert with files issued by your
internal CA (or a public CA). Keep the same .env paths — no other
changes needed.

MCP client note
───────────────
MCP clients (Claude Code, Claude Desktop) will reject self-signed certs by
default unless the cert is added to the system trust store.

  Windows — trust the cert in one command (run as Administrator):
    Import-Certificate -FilePath certs\\server.cert -CertStoreLocation Cert:\\LocalMachine\\Root

  Then re-connect the MCP client.
`);
