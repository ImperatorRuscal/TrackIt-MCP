#!/usr/bin/env node
/**
 * Builds dist/trackit-connector.mcpb — the Claude Desktop installable connector.
 *
 * Usage:  npm run build-connector
 *
 * What it does:
 *   1. Uses esbuild to bundle src/server-stdio.ts + all dependencies into a
 *      single connector/server.js (no node_modules directory needed)
 *   2. ZIPs connector/manifest.json + connector/server.js → dist/trackit-connector.mcpb
 *
 * To change the Track-It API URL: edit connector/manifest.json → mcp_config.env.TRACKIT_BASE_URL
 * then re-run this script and redistribute the .mcpb file.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, existsSync, rmSync, renameSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const ROOT        = resolve(__dirname, '..');
const CONNECTOR   = join(ROOT, 'connector');
const DIST        = join(ROOT, 'dist');
const OUTPUT      = join(DIST, 'trackit-connector.mcpb');
const BUNDLE_OUT  = join(CONNECTOR, 'server.js');

// ── Step 1: bundle src/server-stdio.ts → connector/server.js ─────────────────
console.log('Bundling connector (esbuild)...');
execFileSync('node', [
  join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  'src/server-stdio.ts',
  '--bundle',
  '--platform=node',
  '--target=node18',
  '--format=cjs',
  '--outfile=' + BUNDLE_OUT,
  '--log-level=warning',
], {
  cwd: ROOT,
  stdio: 'inherit',
});
console.log('✓ Bundle written to connector/server.js');

// ── Step 2: prepare output directory ─────────────────────────────────────────
mkdirSync(DIST, { recursive: true });
if (existsSync(OUTPUT)) rmSync(OUTPUT);

// ── Step 3: ZIP manifest.json + server.js → .mcpb via PowerShell ─────────────
// Only these two files go into the archive — no node_modules needed.
console.log('\nPackaging connector...');

const TEMP_ZIP  = join(DIST, 'trackit-connector.zip');
if (existsSync(TEMP_ZIP)) rmSync(TEMP_ZIP);

const manifest = join(CONNECTOR, 'manifest.json').replace(/\\/g, '/');
const bundle   = BUNDLE_OUT.replace(/\\/g, '/');
const tempPath = TEMP_ZIP.replace(/\\/g, '/');

execFileSync('powershell', [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `Compress-Archive -Path "${manifest}","${bundle}" -DestinationPath "${tempPath}"`,
], { stdio: 'inherit' });

renameSync(TEMP_ZIP, OUTPUT);

console.log(`\n✓ Built: dist/trackit-connector.mcpb`);
console.log('\nNext steps:');
console.log('  • Test: double-click the .mcpb in Windows Explorer to install in Claude Desktop');
console.log('  • Distribute: upload to your team share or intranet');
