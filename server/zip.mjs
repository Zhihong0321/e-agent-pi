import { deflateRawSync } from "node:zlib";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS = new Set([".git", ".impeccable", ".pi", "node_modules"]);
const SKIP_FILES = new Set(["product.md", "design.md", ".ds_store"]);
const SKIP_BASENAMES = new Set([
  "profile-2025.pdf",
  "all-certs.pdf",
  "solar-panel.png",
  "solar-panel-2.png",
]);

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear() - 1980, 0);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = (year << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function u16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  return buf;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

/**
 * @param {string} dir
 * @param {string} [base]
 * @returns {Promise<{ name: string; data: Buffer; mtime: Date }[]>}
 */
async function collectFiles(dir, base = dir) {
  /** @type {{ name: string; data: Buffer; mtime: Date }[]} */
  const out = [];
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await collectFiles(full, base)));
      continue;
    }
    if (SKIP_FILES.has(entry.name.toLowerCase())) continue;
    if (SKIP_BASENAMES.has(entry.name.toLowerCase())) continue;
    const info = await stat(full);
    out.push({
      name: path.relative(base, full).replaceAll("\\", "/"),
      data: await readFile(full),
      mtime: info.mtime,
    });
  }
  return out;
}

/**
 * Zip a directory (store paths relative to the folder root).
 * @param {string} dir
 */
export async function zipDirectory(dir) {
  const files = await collectFiles(dir);
  const chunks = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const compressed = deflateRawSync(file.data);
    const crc = crc32(file.data);
    const { dosTime, dosDate } = dosDateTime(file.mtime);
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20),
      u16(0x0800),
      u16(8),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(compressed.length),
      u32(file.data.length),
      u16(name.length),
      u16(0),
      name,
      compressed,
    ]);
    const central = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(8),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(compressed.length),
      u32(file.data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    chunks.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const central = Buffer.concat(centrals);
  const end = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...chunks, central, end]);
}
