// Checks that the extension you installed runs this code: rebuilds the open bundles (build.mjs) and compares them,
// byte for byte, with the same files in a published copy of the extension.
//
//   npm run verify -- <path>
//
// <path> can be:
//   - the .crx from the Chrome Web Store, or a release .zip;
//   - the installed extension's folder. In Chrome, open chrome://version and look at "Profile Path"; the extension is
//     in <Profile Path>/Extensions/<extension id>/<version>/.
// No dependencies beyond Node: the zip reader below is enough for .zip and .crx files.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

const FILES = ["background.js", "wallet.js", "wallet-worker.js"];
const target = process.argv[2];
if (!target || !existsSync(target)) {
  console.error("Usage: npm run verify -- <extension .crx, .zip or folder>");
  process.exit(2);
}

/** Reads the named files out of a .zip or .crx (a .crx is a header followed by a zip). */
function readZip(path, names) {
  const buf = readFileSync(path);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${path} isn't a zip or crx file`);
  const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOffset = buf.readUInt32LE(eocd + 16);
  // in a .crx the offsets count from the start of the zip, after the crx header
  const shift = eocd - cdSize - cdOffset;
  const out = new Map();
  for (let p = eocd - cdSize, n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Bad zip directory");
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42) + shift;
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen).replace(/^\.?\//, "");
    if (names.includes(name)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + size);
      if (method === 0) out.set(name, raw);
      else if (method === 8) out.set(name, inflateRawSync(raw));
      else throw new Error(`${name}: unsupported compression ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readPublished(path, names) {
  if (statSync(path).isDirectory()) {
    return new Map(names.filter((n) => existsSync(join(path, n))).map((n) => [n, readFileSync(join(path, n))]));
  }
  return readZip(path, names);
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
// line endings: a checkout with Windows line endings must not change the result
const norm = (b) => Buffer.from(b.toString("utf8").replace(/\r\n/g, "\n"));

execFileSync(process.execPath, ["build.mjs"], { stdio: ["ignore", "ignore", "inherit"] });
const published = readPublished(target, FILES);
let bad = 0;
for (const name of FILES) {
  const mine = norm(readFileSync(join("dist", name)));
  const theirs = published.get(name);
  if (!theirs) { console.log(`MISSING  ${name} isn't in ${target}`); bad++; continue; }
  const same = mine.equals(norm(theirs));
  console.log(`${same ? "SAME    " : "DIFFERENT"} ${name}  built ${sha256(mine).slice(0, 16)}  published ${sha256(norm(theirs)).slice(0, 16)}`);
  if (!same) bad++;
}
console.log(bad ? "\nThe published extension doesn't match this source." : "\nThe published extension runs exactly this source.");
process.exit(bad ? 1 : 0);
