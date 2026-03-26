#!/usr/bin/env node
/**
 * Builds dist/trackit-connector.mcpb — the Claude Desktop installable connector.
 *
 * Usage:  npm run build-connector
 *
 * What it does:
 *   1. Runs "npm install --omit=dev" in connector/ to bundle mcp-remote
 *   2. ZIPs connector/* into dist/trackit-connector.mcpb using PowerShell
 *
 * To update the server URL: edit connector/manifest.json → mcp_config.env.TRACKIT_URL
 * then re-run this script and redistribute the new .mcpb file.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, existsSync, rmSync, renameSync } from 'fs';
import { join, resolve } from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const ROOT        = resolve(__dirname, '..');
const CONNECTOR   = join(ROOT, 'connector');
const DIST        = join(ROOT, 'dist');
const OUTPUT      = join(DIST, 'trackit-connector.mcpb');

// ── Step 1: install connector dependencies ───────────────────────────────────
console.log('Installing connector dependencies (this may take a moment)...');
execFileSync('npm', ['install', '--omit=dev'], {
  cwd: CONNECTOR,
  stdio: 'inherit',
  shell: true,          // npm is a cmd script on Windows; shell: true is required
});

// ── Step 2: prepare output directory ─────────────────────────────────────────
mkdirSync(DIST, { recursive: true });
if (existsSync(OUTPUT)) rmSync(OUTPUT);

// ── Step 3: ZIP connector/* → .mcpb via PowerShell ───────────────────────────
// Compress-Archive only accepts .zip as the output extension, so we write a
// temporary .zip then rename it to .mcpb (they are the same binary format).
console.log('\nPackaging connector...');

const TEMP_ZIP = join(DIST, 'trackit-connector.zip');
if (existsSync(TEMP_ZIP)) rmSync(TEMP_ZIP);

const srcGlob = join(CONNECTOR, '*').replace(/\\/g, '/');
const tempPath = TEMP_ZIP.replace(/\\/g, '/');

execFileSync('powershell', [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `Compress-Archive -Path "${srcGlob}" -DestinationPath "${tempPath}"`,
], { stdio: 'inherit' });

renameSync(TEMP_ZIP, OUTPUT);

console.log(`\n✓ Built: dist/trackit-connector.mcpb`);
console.log('\nNext steps:');
console.log('  • Test: double-click the .mcpb in Windows Explorer to install in Claude Desktop');
console.log('  • Distribute: upload to your team share, intranet, or Claude Enterprise registry');
