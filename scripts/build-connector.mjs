/**
 * Build script: bundles TypeScript into a single server.js and packages it
 * with manifest.json into a .mcpb file (which is just a ZIP archive).
 *
 * Usage:  node scripts/build-connector.mjs
 * Output: connector/trackit-mcp.mcpb
 *
 * The .mcpb is a ZIP containing:
 *   manifest.json
 *   server.js
 */

import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const connectorDir = join(root, "connector");

// ─── 1. esbuild bundle ───────────────────────────────────────────────────────

console.log("Bundling src/server-stdio.ts ...");

await build({
  entryPoints: [join(root, "src", "server-stdio.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: join(connectorDir, "server.js"),
  // These Node built-ins are always available in Claude Desktop's embedded runtime
  external: ["https", "http", "readline", "crypto", "buffer", "url", "path"],
  logLevel: "info",
  plugins: [
    {
      // Claude Desktop's embedded Node.js supports bare built-in names (e.g. "process",
      // "https") but not the "node:" URL-scheme prefix (e.g. "node:process").
      // The MCP SDK imports 'node:process' in StdioServerTransport, which esbuild would
      // leave as require("node:process") — a top-level call that crashes before our
      // error handlers are registered.  Strip the prefix so the bundle uses the bare
      // name that the embedded runtime understands.
      name: "strip-node-prefix",
      setup(build) {
        build.onResolve({ filter: /^node:/ }, (args) => ({
          path: args.path.slice("node:".length), // "node:process" → "process"
          external: true,
        }));
      },
    },
  ],
});

console.log("Bundle written to connector/server.js");

// ─── 2. Read files to ZIP ────────────────────────────────────────────────────

const manifestBytes = readFileSync(join(connectorDir, "manifest.json"));
const serverBytes = readFileSync(join(connectorDir, "server.js"));

// ─── 3. Build ZIP (no external dependency) ──────────────────────────────────
//
// We implement a minimal ZIP writer from scratch so the build script has
// zero npm dependencies beyond esbuild.  We only need DEFLATE-less "stored"
// entries because the .mcpb format doesn't require compression.

function crc32(buf) {
  const table = crc32.table || (crc32.table = makeCrc32Table());
  let crc = 0xffffffff;
  for (const b of buf) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrc32Table() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
}

function dosDateTime() {
  const now = new Date();
  const d =
    ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const t = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  return { d, t };
}

function localFileHeader(name, data) {
  const { d, t } = dosDateTime();
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data);
  const buf = Buffer.alloc(30 + nameBuf.length);
  buf.writeUInt32LE(0x04034b50, 0);  // local file header signature
  buf.writeUInt16LE(20, 4);           // version needed
  buf.writeUInt16LE(0, 6);            // general purpose bit flag
  buf.writeUInt16LE(0, 8);            // compression method: stored
  buf.writeUInt16LE(t, 10);           // last mod time
  buf.writeUInt16LE(d, 12);           // last mod date
  buf.writeUInt32LE(crc, 14);         // crc-32
  buf.writeUInt32LE(data.length, 18); // compressed size
  buf.writeUInt32LE(data.length, 22); // uncompressed size
  buf.writeUInt16LE(nameBuf.length, 26); // file name length
  buf.writeUInt16LE(0, 28);           // extra field length
  nameBuf.copy(buf, 30);
  return { header: buf, crc, dosDate: d, dosTime: t };
}

function centralDirEntry(name, data, offset, crc, dosDate, dosTime) {
  const nameBuf = Buffer.from(name, "utf8");
  const buf = Buffer.alloc(46 + nameBuf.length);
  buf.writeUInt32LE(0x02014b50, 0);  // central directory signature
  buf.writeUInt16LE(20, 4);           // version made by
  buf.writeUInt16LE(20, 6);           // version needed
  buf.writeUInt16LE(0, 8);            // general purpose bit flag
  buf.writeUInt16LE(0, 10);           // compression method: stored
  buf.writeUInt16LE(dosTime, 12);
  buf.writeUInt16LE(dosDate, 14);
  buf.writeUInt32LE(crc, 16);
  buf.writeUInt32LE(data.length, 20);
  buf.writeUInt32LE(data.length, 24);
  buf.writeUInt16LE(nameBuf.length, 28);
  buf.writeUInt16LE(0, 30);           // extra field length
  buf.writeUInt16LE(0, 32);           // comment length
  buf.writeUInt16LE(0, 34);           // disk number start
  buf.writeUInt16LE(0, 36);           // internal attributes
  buf.writeUInt32LE(0, 38);           // external attributes
  buf.writeUInt32LE(offset, 42);      // relative offset of local header
  nameBuf.copy(buf, 46);
  return buf;
}

function endOfCentralDirectory(count, cdSize, cdOffset) {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(0x06054b50, 0);  // end of central dir signature
  buf.writeUInt16LE(0, 4);            // disk number
  buf.writeUInt16LE(0, 6);            // disk with start of central dir
  buf.writeUInt16LE(count, 8);        // entries on this disk
  buf.writeUInt16LE(count, 10);       // total entries
  buf.writeUInt32LE(cdSize, 12);      // size of central directory
  buf.writeUInt32LE(cdOffset, 16);    // offset of central directory
  buf.writeUInt16LE(0, 20);           // comment length
  return buf;
}

function buildZip(entries) {
  // entries: Array<{ name: string, data: Buffer }>
  const parts = [];
  const centralDirs = [];
  let offset = 0;

  for (const entry of entries) {
    const { header, crc, dosDate, dosTime } = localFileHeader(entry.name, entry.data);
    centralDirs.push(centralDirEntry(entry.name, entry.data, offset, crc, dosDate, dosTime));
    parts.push(header);
    parts.push(entry.data);
    offset += header.length + entry.data.length;
  }

  const cdBuf = Buffer.concat(centralDirs);
  const eocd = endOfCentralDirectory(entries.length, cdBuf.length, offset);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

// ─── 4. Package ──────────────────────────────────────────────────────────────

console.log("Packaging .mcpb ...");

const zip = buildZip([
  { name: "manifest.json", data: manifestBytes },
  { name: "server.js", data: serverBytes },
]);

const outPath = join(connectorDir, "trackit-mcp.mcpb");
writeFileSync(outPath, zip);
console.log(`Done! connector/trackit-mcp.mcpb (${(zip.length / 1024).toFixed(1)} KB)`);
