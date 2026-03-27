'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ---------------------------------------------------------------------------
// Logging: write to stderr (Claude Desktop log) AND a temp file so we can
// confirm whether server.js is running regardless of how Claude Desktop
// handles stdio.  Check: %TEMP%\trackit-connector.log
// ---------------------------------------------------------------------------
const LOG_FILE = path.join(os.tmpdir(), 'trackit-connector.log');
function log(msg) {
  const line = new Date().toISOString() + ' [trackit] ' + msg + '\n';
  process.stderr.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}

log('server.js starting — node ' + process.version + ' pid ' + process.pid);
log('log file: ' + LOG_FILE);
log('__dirname: ' + __dirname);

const group    = (process.env.TRACKIT_GROUP    || '').trim();
const domain   = (process.env.TRACKIT_DOMAIN   || '').trim();
const username = (process.env.TRACKIT_USERNAME  || '').trim();
const password =  process.env.TRACKIT_PASSWORD  || '';
const url      =  process.env.TRACKIT_URL       || '';

log('env TRACKIT_URL=' + (url || '(not set)'));
log('env TRACKIT_GROUP=' + (group || '(not set)'));
log('env TRACKIT_DOMAIN=' + (domain || '(not set)'));
log('env TRACKIT_USERNAME=' + (username || '(not set)'));
log('env TRACKIT_PASSWORD=' + (password ? '(set)' : '(not set)'));

if (!group || !domain || !username || !password) {
  log('ERROR: Missing credentials. Reinstall the connector and fill in all required fields.');
  process.exit(1);
}

if (!url) {
  log('ERROR: TRACKIT_URL is not configured. This is a bug in the connector package.');
  process.exit(1);
}

// Build the Track-It credential string: GROUP\DOMAIN\username:password → base64
const credential = group + '\\' + domain + '\\' + username + ':' + password;
const authHeader = 'Authorization:Basic ' + Buffer.from(credential, 'utf8').toString('base64');

// Locate mcp-remote using an explicit path (more reliable inside Claude Desktop's
// embedded Node.js than require.resolve which depends on module search paths).
const mcpRemoteDir = path.join(__dirname, 'node_modules', 'mcp-remote');

let mcpRemoteScript;
try {
  const mcpRemotePkg = JSON.parse(fs.readFileSync(path.join(mcpRemoteDir, 'package.json'), 'utf8'));
  const binRelPath   = typeof mcpRemotePkg.bin === 'object'
    ? mcpRemotePkg.bin['mcp-remote']
    : mcpRemotePkg.bin;
  mcpRemoteScript = path.join(mcpRemoteDir, binRelPath);
} catch (err) {
  log('ERROR: Could not locate mcp-remote package: ' + err.message);
  process.exit(1);
}

log('mcp-remote script: ' + mcpRemoteScript);
log('mcp-remote exists: ' + fs.existsSync(mcpRemoteScript));
log('process.execPath: ' + process.execPath);

if (!fs.existsSync(mcpRemoteScript)) {
  log('ERROR: mcp-remote script not found. The connector package may be corrupted.');
  process.exit(1);
}

// NODE_TLS_REJECT_UNAUTHORIZED=0 allows mcp-remote to connect to servers with
// self-signed or internally-issued TLS certificates.  Claude Desktop's embedded
// Node.js does not share the Windows certificate store, so it rejects certs that
// are trusted in the OS.  This is safe for a controlled corporate-intranet URL.
log('spawning mcp-remote...');
const child = spawn(
  process.execPath,
  [mcpRemoteScript, url, '--header', authHeader, '--debug'],
  {
    stdio: 'inherit',
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  }
);

child.on('exit',  (code, signal) => {
  log('mcp-remote exited: code=' + code + ' signal=' + signal);
  process.exit(code ?? 0);
});
child.on('error', (err) => {
  log('ERROR: Failed to start mcp-remote: ' + err.message);
  process.exit(1);
});

log('mcp-remote spawned, pid=' + (child.pid || 'unknown'));
