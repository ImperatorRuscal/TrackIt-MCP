'use strict';
// ──────────────────────────────────────────────────────────────────────────────
// TrackIt MCP Connector – minimal stdio ↔ HTTPS proxy
//
// Uses ONLY Node.js built-in modules so it works inside Claude Desktop's
// embedded / sandboxed Node.js environment without any npm dependencies.
// ──────────────────────────────────────────────────────────────────────────────

// Write to stderr BEFORE any require() so we can see if this file even runs.
process.stderr.write('[trackit] server.js loaded\n');

const https    = require('https');
const http     = require('http');
const readline = require('readline');

process.stderr.write('[trackit] built-ins loaded\n');

// ── Bypass TLS cert validation ────────────────────────────────────────────────
// Claude Desktop's embedded Node.js does not share the Windows certificate
// store, so even valid corporate-CA-issued certs may be rejected.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ── Credentials ───────────────────────────────────────────────────────────────
const group    = (process.env.TRACKIT_GROUP    || '').trim();
const domain   = (process.env.TRACKIT_DOMAIN   || '').trim();
const username = (process.env.TRACKIT_USERNAME  || '').trim();
const password =  process.env.TRACKIT_PASSWORD  || '';
const rawUrl   =  process.env.TRACKIT_URL       || '';

process.stderr.write('[trackit] url=' + (rawUrl || '(not set)') + '\n');
process.stderr.write('[trackit] group=' + (group || '(not set)') + '\n');

if (!group || !domain || !username || !password || !rawUrl) {
  process.stderr.write('[trackit] ERROR: Missing credentials or URL. Reinstall connector.\n');
  process.exit(1);
}

const credential  = group + '\\' + domain + '\\' + username + ':' + password;
const bearerValue = 'Basic ' + Buffer.from(credential, 'utf8').toString('base64');

// ── Parse remote URL ──────────────────────────────────────────────────────────
let parsedUrl;
try {
  parsedUrl = new URL(rawUrl);
} catch (e) {
  process.stderr.write('[trackit] ERROR: Invalid TRACKIT_URL: ' + e.message + '\n');
  process.exit(1);
}

const host     = parsedUrl.hostname;
const port     = parseInt(parsedUrl.port, 10) || (parsedUrl.protocol === 'https:' ? 443 : 80);
const basePath = parsedUrl.pathname;
const useHttps = parsedUrl.protocol === 'https:';
const transport = useHttps ? https : http;

process.stderr.write('[trackit] target=' + host + ':' + port + basePath + '\n');

// ── Session state ─────────────────────────────────────────────────────────────
let sessionId = null;

// ── HTTP POST helper ──────────────────────────────────────────────────────────
// Returns an array of parsed JSON-RPC objects from the server response.
// Handles both plain JSON and text/event-stream (SSE) responses.
function postMcp(body) {
  return new Promise(function (resolve, reject) {
    var payload = JSON.stringify(body);
    var headers = {
      'content-type':   'application/json',
      'accept':         'application/json, text/event-stream',
      'authorization':  bearerValue,
      'content-length': Buffer.byteLength(payload).toString(),
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    var options = {
      hostname:           host,
      port:               port,
      path:               basePath,
      method:             'POST',
      headers:            headers,
      rejectUnauthorized: false,
    };

    var req = transport.request(options, function (res) {
      if (res.headers['mcp-session-id']) {
        sessionId = res.headers['mcp-session-id'];
        process.stderr.write('[trackit] session=' + sessionId.slice(0, 8) + '…\n');
      }

      var ct = res.headers['content-type'] || '';
      var results = [];

      if (ct.indexOf('text/event-stream') !== -1) {
        // SSE — collect data: lines
        var buf = '';
        res.on('data', function (chunk) {
          buf += chunk.toString();
          var lines = buf.split('\n');
          buf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('data: ') === 0) {
              var d = line.slice(6).trim();
              if (d && d !== '[DONE]') {
                try { results.push(JSON.parse(d)); } catch (_) {}
              }
            }
          }
        });
        res.on('end', function () { resolve(results); });
      } else {
        // Plain JSON
        var chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          var text = Buffer.concat(chunks).toString().trim();
          if (!text) { resolve([]); return; }
          try { resolve([JSON.parse(text)]); } catch (_) { resolve([]); }
        });
      }
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Stdio MCP loop ────────────────────────────────────────────────────────────
var rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', function (line) {
  line = line.trim();
  if (!line) return;

  var msg;
  try { msg = JSON.parse(line); }
  catch (_) { return; }

  process.stderr.write('[trackit] → ' + msg.method + '\n');

  postMcp(msg).then(function (responses) {
    for (var i = 0; i < responses.length; i++) {
      process.stdout.write(JSON.stringify(responses[i]) + '\n');
    }
    if (responses.length > 0) {
      process.stderr.write('[trackit] ← ' + responses.length + ' msg(s)\n');
    }
  }).catch(function (err) {
    process.stderr.write('[trackit] HTTP error: ' + err.message + '\n');
    if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id:      msg.id,
        error:   { code: -32603, message: 'Proxy error: ' + err.message },
      }) + '\n');
    }
  });
});

rl.on('close', function () {
  process.stderr.write('[trackit] stdin closed\n');
  process.exit(0);
});

process.stderr.write('[trackit] ready\n');
