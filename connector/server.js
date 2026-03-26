'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

process.stderr.write('[trackit] server.js starting, node ' + process.version + '\n');
process.stderr.write('[trackit] __dirname: ' + __dirname + '\n');

const group    = (process.env.TRACKIT_GROUP    || '').trim();
const domain   = (process.env.TRACKIT_DOMAIN   || '').trim();
const username = (process.env.TRACKIT_USERNAME  || '').trim();
const password =  process.env.TRACKIT_PASSWORD  || '';
const url      =  process.env.TRACKIT_URL       || '';

if (!group || !domain || !username || !password) {
  process.stderr.write('[trackit] Missing credentials. Reinstall the connector and fill in all required fields.\n');
  process.exit(1);
}

if (!url) {
  process.stderr.write('[trackit] TRACKIT_URL is not configured. This is a bug in the connector package.\n');
  process.exit(1);
}

process.stderr.write('[trackit] Credentials present, URL: ' + url + '\n');

// Build the Track-It credential string: GROUP\DOMAIN\username:password → base64
const credential = group + '\\' + domain + '\\' + username + ':' + password;
const authHeader = 'Authorization:Basic ' + Buffer.from(credential, 'utf8').toString('base64');

// Locate mcp-remote using an explicit path (more reliable inside Claude Desktop's
// embedded Node.js than require.resolve which depends on module search paths).
const mcpRemoteDir    = path.join(__dirname, 'node_modules', 'mcp-remote');
const mcpRemotePkg    = JSON.parse(fs.readFileSync(path.join(mcpRemoteDir, 'package.json'), 'utf8'));
const binRelPath      = typeof mcpRemotePkg.bin === 'object'
  ? mcpRemotePkg.bin['mcp-remote']
  : mcpRemotePkg.bin;
const mcpRemoteScript = path.join(mcpRemoteDir, binRelPath);

process.stderr.write('[trackit] mcp-remote script: ' + mcpRemoteScript + '\n');
process.stderr.write('[trackit] mcp-remote exists: ' + fs.existsSync(mcpRemoteScript) + '\n');

// NODE_TLS_REJECT_UNAUTHORIZED=0 allows mcp-remote to connect to servers with
// self-signed or internally-issued TLS certificates.  Claude Desktop's embedded
// Node.js does not share the Windows certificate store, so it rejects certs that
// are trusted in the OS.  This is safe for a controlled corporate-intranet URL.
const child = spawn(
  process.execPath,
  [mcpRemoteScript, url, '--header', authHeader, '--debug'],
  {
    stdio: 'inherit',
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  }
);

child.on('exit',  (code) => {
  process.stderr.write('[trackit] mcp-remote exited with code ' + code + '\n');
  process.exit(code ?? 0);
});
child.on('error', (err)  => {
  process.stderr.write('[trackit] Failed to start mcp-remote: ' + err.message + '\n');
  process.exit(1);
});
