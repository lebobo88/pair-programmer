/**
 * Filesystem and PNG primitives behind `pp_codex.generate_image`.
 *
 * Every security-relevant decision here is its own named, exported function so
 * the unit tests (daemon/test/generate-image.unit.mjs) can drive the real check
 * from both the end-to-end test and its falsification fixture (AGENTS.md
 * "no-vacuous-assertions", class 3).
 *
 * Containment is PHYSICAL, not lexical: directories are compared by
 * `realpathSync.native`, a session or output directory that is itself a
 * symlink/junction is refused (on Node 22 a Windows junction reports
 * `isSymbolicLink()` from `lstat`), and source files are read from an fd whose
 * identity (dev + ino) is re-checked against the path AFTER the open, so a
 * regular-file-to-symlink swap between enumeration and read is detected
 * instead of followed. Node has no `openat`, so the parent-directory checks are
 * re-run immediately before and after every write; the residual window between
 * those checks and the syscall is the narrowest available without native code.
 */
import {
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  readSync,
  writeSync,
  opendirSync,
  mkdirSync,
  unlinkSync,
  constants as FS,
} from "node:fs";
import { join, dirname, basename, extname, resolve } from "node:path";
import zlib from "node:zlib";
import { PNG } from "pngjs";

// ─── caps ────────────────────────────────────────────────────────────────────

/** Downscaling never goes below this longest-side size (px). Also the minimum accepted `max_dimension`. */
export const DOWNSCALE_FLOOR_PX = 256;
/** Maximum accepted `max_dimension` (px). */
export const MAX_DIMENSION_PX = 4096;
/** At most this many PNGs are processed per call; the rest are reported, not read. */
export const MAX_IMAGES_PER_CALL = 20;
/** Directory entries visited in the session dir before enumeration stops (truncation is reported). */
export const MAX_DIR_ENTRIES_SCANNED = 200;
/** Compressed size cap per source PNG, checked via `fstat` BEFORE any byte is read. */
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
/** Decoded pixel cap per source PNG, checked from the validated IHDR before decode. */
export const MAX_DECODED_PIXELS_PER_IMAGE = 4096 * 4096;
/** Alternative output names tried after the first collides; then the image fails. */
export const MAX_OUTPUT_NAME_COLLISIONS = 100;
/** Created output_dir components allowed (bounds the ancestor walk). */
export const MAX_CREATED_OUTPUT_COMPONENTS = 32;
/** Total settle-poll window after the CLI returns. */
export const HARVEST_POLL_TIMEOUT_MS = 3000;
export const HARVEST_POLL_INTERVAL_MS = 100;
/**
 * A file whose mtime is older than the call start minus this slack pre-dates
 * the call (stale carry-over) and is never harvested.
 */
export const STALE_MTIME_SLACK_MS = 2000;

// ─── path identity ───────────────────────────────────────────────────────────

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** True when `childReal` is a DIRECT child of `parentReal`. Both must already be realpaths. */
export function isDirectChildReal(parentReal: string, childReal: string): boolean {
  return samePath(dirname(childReal), parentReal) && basename(childReal).length > 0;
}

/**
 * Codex session ids are UUIDs; they are used as a single path segment under
 * the images root. Hex digits and dashes only, length-bounded — no separator,
 * no dot, so neither `..` nor an absolute path can be expressed.
 */
const SESSION_ID_PATTERN = /^[0-9a-fA-F-]{1,64}$/;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

export type SessionDirResolution =
  | { kind: "ok"; rootReal: string; dirReal: string }
  | { kind: "absent"; reason: string }
  | { kind: "rejected"; reason: string };

/**
 * Resolve `<imagesRoot>/<sessionId>` physically. Refuses a session directory
 * that is itself a symlink/junction (even one aliasing ANOTHER session's
 * directory inside the root) and one whose realpath is not a direct child of
 * the images root's realpath.
 */
export function resolveSessionDir(imagesRoot: string, sessionId: string): SessionDirResolution {
  if (!isValidSessionId(sessionId)) {
    return { kind: "rejected", reason: `session_id "${sessionId}" is not a safe single path segment (hex/dash only).` };
  }
  let rootReal: string;
  try {
    rootReal = realpathSync.native(imagesRoot);
  } catch {
    return { kind: "absent", reason: `images root ${imagesRoot} does not exist.` };
  }
  const candidate = join(rootReal, sessionId);
  const st = lstatSync(candidate, { throwIfNoEntry: false });
  if (!st) return { kind: "absent", reason: `no directory exists for session ${sessionId}.` };
  if (st.isSymbolicLink()) {
    return { kind: "rejected", reason: `session directory ${candidate} is a symlink/junction; refusing to follow it.` };
  }
  if (!st.isDirectory()) {
    return { kind: "rejected", reason: `session path ${candidate} is not a directory.` };
  }
  let dirReal: string;
  try {
    dirReal = realpathSync.native(candidate);
  } catch (err) {
    return { kind: "absent", reason: `session directory vanished: ${(err as Error).message}` };
  }
  if (!isDirectChildReal(rootReal, dirReal)) {
    return { kind: "rejected", reason: `session directory resolves to ${dirReal}, outside images root ${rootReal}.` };
  }
  return { kind: "ok", rootReal, dirReal };
}

// ─── enumeration ─────────────────────────────────────────────────────────────

export type SessionListing = {
  /** Regular files named *.png, sorted. */
  pngNames: string[];
  /** *.png entries that are NOT regular files (symlinks, junctions, directories). */
  nonRegularPngs: string[];
  /** Directory entries visited. Never exceeds `maxEntries`. */
  scanned: number;
  /** True when entries remained after `maxEntries` were visited. */
  truncated: boolean;
};

/**
 * Enumerate at most `maxEntries` entries of `dirReal` WITHOUT following
 * links (`Dirent` types come from the directory itself). Stops early instead
 * of materialising an unbounded listing.
 */
export function listSessionEntries(dirReal: string, maxEntries: number): SessionListing {
  const pngNames: string[] = [];
  const nonRegularPngs: string[] = [];
  let scanned = 0;
  let truncated = false;
  const dir = opendirSync(dirReal);
  try {
    for (;;) {
      if (scanned >= maxEntries) {
        truncated = dir.readSync() !== null;
        break;
      }
      const ent = dir.readSync();
      if (ent === null) break;
      scanned += 1;
      if (!ent.name.toLowerCase().endsWith(".png")) continue;
      if (ent.isFile()) pngNames.push(ent.name);
      else nonRegularPngs.push(ent.name);
    }
  } finally {
    dir.closeSync();
  }
  pngNames.sort();
  nonRegularPngs.sort();
  return { pngNames, nonRegularPngs, scanned, truncated };
}

// ─── verified open / read ────────────────────────────────────────────────────

/** Test-only seams fired around the verified open. Production never sets them. */
export type FileOpenHooks = {
  beforeOpen?: (path: string) => void;
  afterOpen?: (path: string) => void;
  afterVerify?: (path: string) => void;
};

export type VerifiedFile =
  | { ok: true; fd: number; size: number; mtimeMs: number }
  | {
      ok: false;
      reason: string;
      /** True for rejections no amount of waiting can fix (symlink, size cap, escape). */
      terminal: boolean;
    };

const OPEN_READ_FLAGS = FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0);

/**
 * Open `<dirReal>/<name>` and prove the open fd is the regular file that sits
 * at that path inside `dirReal`:
 *   1. open (O_NOFOLLOW + O_NONBLOCK where the platform has them);
 *   2. `fstat` the FD: must be a regular file no larger than `maxBytes` —
 *      checked before a single byte is read;
 *   3. `lstat` the PATH: must not be a symlink, and must have the fd's dev+ino
 *      (a path swapped after the open, or a symlink followed by the open, fails here);
 *   4. realpath of the path must be a direct child of `dirReal`.
 * The caller reads from the returned fd only, so a later swap of the path
 * cannot redirect the read. The caller owns closing the fd.
 */
export function openVerifiedFile(
  dirReal: string,
  name: string,
  maxBytes: number,
  hooks: FileOpenHooks = {},
): VerifiedFile {
  const p = join(dirReal, name);
  hooks.beforeOpen?.(p);
  let fd: number;
  try {
    fd = openSync(p, OPEN_READ_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, reason: `open failed (${code ?? "error"}).`, terminal: code === "ELOOP" };
  }
  const fail = (reason: string, terminal: boolean): VerifiedFile => {
    closeSync(fd);
    return { ok: false, reason, terminal };
  };
  try {
    hooks.afterOpen?.(p);
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) return fail("not a regular file.", true);
    if (st.size > BigInt(maxBytes)) {
      return fail(`size ${st.size} bytes exceeds the per-image size cap (${maxBytes} bytes); not read.`, true);
    }
    const lst = lstatSync(p, { bigint: true, throwIfNoEntry: false });
    if (!lst) return fail("path vanished after open.", false);
    if (lst.isSymbolicLink()) return fail("path is a symlink/junction; refusing to read through it.", true);
    if (lst.ino !== st.ino || lst.dev !== st.dev) {
      return fail("path was replaced between open and verification; refusing the read.", true);
    }
    const real = realpathSync.native(p);
    if (!isDirectChildReal(dirReal, real)) {
      return fail(`file resolves to ${real}, outside the session directory.`, true);
    }
    hooks.afterVerify?.(p);
    return { ok: true, fd, size: Number(st.size), mtimeMs: Number(st.mtimeMs) };
  } catch (err) {
    return fail(`verification failed: ${(err as Error).message}`, false);
  }
}

/** Read exactly `size` bytes from `fd`; throws on a short read or if the file grew past `size`. */
export function readFdFully(fd: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = readSync(fd, buf, off, size - off, off);
    if (n === 0) throw new Error(`short read: ${off} of ${size} bytes.`);
    off += n;
  }
  const probe = Buffer.alloc(1);
  if (readSync(fd, probe, 0, 1, size) !== 0) throw new Error("file grew while being read.");
  return buf;
}

// ─── PNG structure ───────────────────────────────────────────────────────────

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A complete PNG ends with this exact 12-byte IEND chunk (length 0, type, CRC). */
const IEND_CHUNK = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

let crcTable: Uint32Array | undefined;
function crc32Fallback(buf: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crcTable[(crc ^ (buf[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
// zlib.crc32 landed in Node 22.2; the engines floor is 22.0.
const crc32: (buf: Uint8Array) => number =
  typeof (zlib as { crc32?: unknown }).crc32 === "function"
    ? (buf) => zlib.crc32(buf) >>> 0
    : crc32Fallback;

const VALID_BIT_DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

export type PngStructure =
  | { ok: true; width: number; height: number; bitDepth: number; colorType: number }
  | { ok: false; reason: string };

/**
 * Validate the WHOLE PNG container before any file is accepted — including the
 * fits-as-is verbatim copy: signature; first chunk IHDR with length 13, legal
 * fields and a correct CRC; every chunk's length in bounds and CRC correct; at
 * least one IDAT; PLTE before IDAT for palette images; and a final IEND with no
 * trailing bytes. A 24-byte header, a truncated file and a flipped CRC all fail.
 */
export function validatePngStructure(buf: Buffer): PngStructure {
  if (buf.length < PNG_SIGNATURE.length || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ok: false, reason: "missing PNG signature." };
  }
  let off = 8;
  let index = 0;
  let ihdr: { width: number; height: number; bitDepth: number; colorType: number } | undefined;
  let idatCount = 0;
  let sawPlte = false;
  let sawIend = false;
  while (off < buf.length) {
    if (sawIend) return { ok: false, reason: "bytes after IEND." };
    if (off + 12 > buf.length) return { ok: false, reason: `truncated chunk header at byte ${off}.` };
    const len = buf.readUInt32BE(off);
    if (len > 0x7fffffff) return { ok: false, reason: `chunk length ${len} out of range at byte ${off}.` };
    const end = off + 12 + len;
    if (end > buf.length) return { ok: false, reason: `chunk at byte ${off} runs past end of file (truncated).` };
    const type = buf.toString("latin1", off + 4, off + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return { ok: false, reason: `invalid chunk type at byte ${off}.` };
    const expected = buf.readUInt32BE(off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== expected) {
      return { ok: false, reason: `CRC mismatch in ${type} chunk at byte ${off}.` };
    }
    if (index === 0 && type !== "IHDR") return { ok: false, reason: "first chunk is not IHDR." };
    if (type === "IHDR") {
      if (index !== 0) return { ok: false, reason: "IHDR is not the first chunk." };
      if (len !== 13) return { ok: false, reason: `IHDR length ${len}, expected 13.` };
      const d = off + 8;
      const width = buf.readUInt32BE(d);
      const height = buf.readUInt32BE(d + 4);
      const bitDepth = buf[d + 8] as number;
      const colorType = buf[d + 9] as number;
      if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
        return { ok: false, reason: `IHDR dimensions ${width}x${height} out of range.` };
      }
      if (!VALID_BIT_DEPTHS[colorType]?.includes(bitDepth)) {
        return { ok: false, reason: `IHDR colour type ${colorType} / bit depth ${bitDepth} is not a legal combination.` };
      }
      if (buf[d + 10] !== 0 || buf[d + 11] !== 0 || (buf[d + 12] as number) > 1) {
        return { ok: false, reason: "IHDR compression/filter/interlace method is invalid." };
      }
      ihdr = { width, height, bitDepth, colorType };
    } else if (type === "PLTE") {
      sawPlte = true;
    } else if (type === "IDAT") {
      if (ihdr?.colorType === 3 && !sawPlte) return { ok: false, reason: "palette image has IDAT before PLTE." };
      idatCount += 1;
    } else if (type === "IEND") {
      if (len !== 0) return { ok: false, reason: "IEND chunk has a non-zero length." };
      sawIend = true;
    }
    off = end;
    index += 1;
  }
  if (!ihdr) return { ok: false, reason: "no IHDR chunk." };
  if (idatCount === 0) return { ok: false, reason: "no IDAT chunk." };
  if (!sawIend) return { ok: false, reason: "no IEND chunk (truncated)." };
  return { ok: true, ...ihdr };
}

/** Cheap completeness hint used while polling: does the file end with the IEND chunk? */
export function hasPngTrailer(fd: number, size: number): boolean {
  if (size < PNG_SIGNATURE.length + IEND_CHUNK.length) return false;
  const tail = Buffer.alloc(IEND_CHUNK.length);
  const n = readSync(fd, tail, 0, tail.length, size - tail.length);
  return n === tail.length && tail.equals(IEND_CHUNK);
}

// ─── settle polling ──────────────────────────────────────────────────────────

export type SettleOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  maxImages?: number;
  maxEntries?: number;
  maxBytes?: number;
};

export type SettledHarvest =
  | { kind: "rejected"; reason: string }
  | { kind: "absent"; reason: string }
  | {
      kind: "ok";
      dirReal: string;
      /** Size+mtime unchanged across two consecutive polls AND ending in IEND. */
      settled: { name: string; mtimeMs: number }[];
      /** Still changing or incomplete when the poll window closed. */
      unsettled: { name: string; reason: string }[];
      /** Refused by the verified open (symlink, size cap, replaced, escape) or not a regular file. */
      rejected: { name: string; reason: string }[];
      /** Regular PNGs beyond MAX_IMAGES_PER_CALL; never opened. */
      overCap: string[];
      scanned: number;
      truncated: boolean;
    };

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Wait (bounded) for the session directory's PNGs to settle. A file is settled
 * when its size and mtime are identical across two consecutive polls AND it
 * ends with an IEND chunk — a partially-flushed PNG is neither. Rejections that
 * waiting cannot fix are reported immediately and never retried. Only the first
 * `maxImages` regular PNG names are ever opened.
 */
export async function pollForSettledPngs(
  imagesRoot: string,
  sessionId: string,
  opts: SettleOptions = {},
): Promise<SettledHarvest> {
  const timeoutMs = opts.timeoutMs ?? HARVEST_POLL_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? HARVEST_POLL_INTERVAL_MS;
  const maxImages = opts.maxImages ?? MAX_IMAGES_PER_CALL;
  const maxEntries = opts.maxEntries ?? MAX_DIR_ENTRIES_SCANNED;
  const maxBytes = opts.maxBytes ?? MAX_SOURCE_BYTES;
  const deadline = Date.now() + timeoutMs;
  let prev = new Map<string, string>();
  const rejected = new Map<string, string>();

  for (;;) {
    const res = resolveSessionDir(imagesRoot, sessionId);
    if (res.kind === "rejected") return res;
    if (res.kind === "ok") {
      const listing = listSessionEntries(res.dirReal, maxEntries);
      for (const n of listing.nonRegularPngs) rejected.set(n, "not a regular file (symlink, junction or directory).");
      const tracked = listing.pngNames.slice(0, maxImages);
      const sig = new Map<string, string>();
      const mtimes = new Map<string, number>();
      const pending = new Map<string, string>();
      for (const name of tracked) {
        if (rejected.has(name)) continue;
        const v = openVerifiedFile(res.dirReal, name, maxBytes);
        if (!v.ok) {
          if (v.terminal) rejected.set(name, v.reason);
          else pending.set(name, v.reason);
          continue;
        }
        try {
          sig.set(name, `${v.size}:${v.mtimeMs}`);
          mtimes.set(name, v.mtimeMs);
          if (!hasPngTrailer(v.fd, v.size)) pending.set(name, "no IEND trailer yet (incomplete or malformed PNG).");
        } finally {
          closeSync(v.fd);
        }
      }
      const live = tracked.filter(n => !rejected.has(n));
      const settled = live.filter(n => !pending.has(n) && sig.has(n) && prev.get(n) === sig.get(n));
      const done = tracked.length > 0 && settled.length === live.length;
      if (done || Date.now() >= deadline) {
        return {
          kind: "ok",
          dirReal: res.dirReal,
          settled: settled.map(name => ({ name, mtimeMs: mtimes.get(name) as number })),
          unsettled: live
            .filter(n => !settled.includes(n))
            .map(name => ({
              name,
              reason: `did not settle within ${timeoutMs}ms: ${pending.get(name) ?? "size/mtime still changing."}`,
            })),
          rejected: [...rejected].map(([name, reason]) => ({ name, reason })),
          overCap: listing.pngNames.slice(maxImages),
          scanned: listing.scanned,
          truncated: listing.truncated,
        };
      }
      prev = sig;
    } else if (Date.now() >= deadline) {
      return res;
    }
    await sleep(intervalMs);
  }
}

// ─── output ──────────────────────────────────────────────────────────────────

export type OutputDirResolution = { ok: true; outReal: string } | { ok: false; reason: string };

/**
 * Create (if needed) and physically resolve `outputDir`. Refuses an
 * output_dir that is itself a symlink/junction, and refuses if any component
 * this call creates turns out to be one (a racing swap). Existing ANCESTORS may
 * be links — the caller chose the path — but every later write is checked
 * against the returned realpath.
 */
export function prepareOutputDir(outputDir: string): OutputDirResolution {
  const abs = resolve(outputDir);
  const toCreate: string[] = [];
  let cur = abs;
  for (;;) {
    if (lstatSync(cur, { throwIfNoEntry: false })) break;
    const parent = dirname(cur);
    if (parent === cur) return { ok: false, reason: `no existing ancestor for output_dir ${abs}.` };
    toCreate.unshift(cur);
    if (toCreate.length > MAX_CREATED_OUTPUT_COMPONENTS) {
      return { ok: false, reason: `output_dir would create more than ${MAX_CREATED_OUTPUT_COMPONENTS} directories.` };
    }
    cur = parent;
  }
  for (const dir of toCreate) {
    try {
      mkdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return { ok: false, reason: `could not create ${dir}: ${(err as Error).message}` };
      }
    }
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink() || !st.isDirectory()) {
      return { ok: false, reason: `created output component ${dir} is not a plain directory (symlink/junction swap?).` };
    }
  }
  const st = lstatSync(abs, { throwIfNoEntry: false });
  if (!st) return { ok: false, reason: `output_dir ${abs} vanished.` };
  if (st.isSymbolicLink()) return { ok: false, reason: `output_dir ${abs} is a symlink/junction; refusing to write through it.` };
  if (!st.isDirectory()) return { ok: false, reason: `output_dir ${abs} is not a directory.` };
  return { ok: true, outReal: realpathSync.native(abs) };
}

/** Throws unless `outReal` is still a plain directory whose realpath is itself. */
export function assertOutputDirIntact(outReal: string): void {
  const st = lstatSync(outReal, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`output_dir ${outReal} is no longer a plain directory (symlink/junction swap?); refusing to write.`);
  }
  if (!samePath(realpathSync.native(outReal), outReal)) {
    throw new Error(`output_dir ${outReal} no longer resolves to itself; refusing to write.`);
  }
}

/**
 * After a write: the written file's realpath parent must equal `outReal`.
 * Returns the file's realpath; throws otherwise.
 */
export function verifyWrittenPath(outReal: string, dest: string): string {
  const real = realpathSync.native(dest);
  if (!isDirectChildReal(outReal, real)) {
    throw new Error(`written file resolves to ${real}, outside output_dir ${outReal}.`);
  }
  return real;
}

/** Restrict a harvested basename to a portable, separator-free filename. */
export function safeOutputName(name: string): string {
  const stem = basename(name, extname(name)).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[.]+/, "").slice(0, 100);
  // Windows reserved device names would open the device, not a file.
  const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(stem);
  return `${stem && !reserved ? stem : `image_${stem}`}.png`;
}

/**
 * Write `buffer` into `outReal` under a sanitized `name`, never following or
 * overwriting an existing entry (`wx` = O_CREAT|O_EXCL). On collision tries
 * `<stem>-1.png` … `<stem>-<maxCollisions>.png`, then throws. The parent is
 * re-checked immediately before each create and the result's realpath parent
 * is verified after it; a file that landed elsewhere is removed and the write
 * fails.
 */
export function writeImageSafely(
  outReal: string,
  name: string,
  buffer: Buffer,
  maxCollisions: number = MAX_OUTPUT_NAME_COLLISIONS,
): string {
  const safe = safeOutputName(name);
  const ext = extname(safe);
  const stem = basename(safe, ext);
  for (let attempt = 0; attempt <= maxCollisions; attempt++) {
    const candidate = attempt === 0 ? safe : `${stem}-${attempt}${ext}`;
    assertOutputDirIntact(outReal);
    const dest = join(outReal, candidate);
    let fd: number;
    try {
      fd = openSync(dest, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    try {
      let off = 0;
      while (off < buffer.length) off += writeSync(fd, buffer, off, buffer.length - off);
    } finally {
      closeSync(fd);
    }
    try {
      assertOutputDirIntact(outReal);
      return verifyWrittenPath(outReal, dest);
    } catch (err) {
      try { unlinkSync(dest); } catch { /* best effort: report the escape regardless */ }
      throw err;
    }
  }
  throw new Error(`output name collision cap reached: ${safe} and ${maxCollisions} alternatives already exist.`);
}

// ─── downscale ───────────────────────────────────────────────────────────────

/** Nearest-neighbour resize; exact fidelity is not required, only fitting the budget. */
function resizePng(src: PNG, width: number, height: number): PNG {
  if (width === src.width && height === src.height) return src;
  const dst = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / width));
      const s = (src.width * sy + sx) << 2;
      const d = (width * y + x) << 2;
      dst.data[d] = src.data[s] as number;
      dst.data[d + 1] = src.data[s + 1] as number;
      dst.data[d + 2] = src.data[s + 2] as number;
      dst.data[d + 3] = src.data[s + 3] as number;
    }
  }
  return dst;
}

/**
 * Fit a decoded PNG within `maxDimension` (longest side) and `byteBudget`.
 * The first attempt is computed directly as `min(maxDimension, longest side)`
 * — a huge `max_dimension` never causes no-op re-encodes — then the cap halves
 * toward `DOWNSCALE_FLOOR_PX` (or the source size, if smaller). `encodes` is
 * at most 1 + log2(MAX_DIMENSION_PX / DOWNSCALE_FLOOR_PX) = 5.
 */
export function downscaleImageToFit(
  original: PNG,
  maxDimension: number,
  byteBudget: number,
): { buffer: Buffer; width: number; height: number; encodes: number } {
  const longest = Math.max(original.width, original.height);
  const floor = Math.min(DOWNSCALE_FLOOR_PX, longest);
  let cap = Math.max(floor, Math.min(maxDimension, longest));
  let encodes = 0;
  for (;;) {
    const scale = cap / longest;
    const width = Math.max(1, Math.round(original.width * scale));
    const height = Math.max(1, Math.round(original.height * scale));
    const buffer = PNG.sync.write(resizePng(original, width, height));
    encodes += 1;
    if (buffer.length <= byteBudget || cap <= floor) return { buffer, width, height, encodes };
    cap = Math.max(floor, Math.floor(cap / 2));
  }
}
