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
  mkdtempSync,
  chmodSync,
  unlinkSync,
  rmdirSync,
  renameSync,
  linkSync,
  ftruncateSync,
  constants as FS,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname, basename, extname, resolve, relative } from "node:path";
import zlib from "node:zlib";
import { PNG } from "pngjs";
import { log } from "../util/logger.js";

// ─── caps ────────────────────────────────────────────────────────────────────

/** Downscaling never goes below this longest-side size (px). Also the minimum accepted `max_dimension`. */
export const DOWNSCALE_FLOOR_PX = 256;
/** Maximum accepted `max_dimension` (px). */
export const MAX_DIMENSION_PX = 4096;
/** At most this many PNGs are processed per call; the rest are reported, not read. */
export const MAX_IMAGES_PER_CALL = 20;
/** Directory entries visited by ONE enumeration of the session dir (truncation is reported). */
export const MAX_DIR_ENTRIES_SCANNED = 200;
/** Directory entries visited across ALL settle polls of one call. */
export const MAX_DIR_ENTRIES_PER_CALL = 1000;
/** File opens across ALL settle polls of one call; the final reads add at most MAX_IMAGES_PER_CALL more. */
export const MAX_POLL_OPENS_PER_CALL = 180;
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
/** Hard cap on settle polls per call (3s / 100ms); no poll starts after the deadline either. */
export const MAX_SETTLE_POLLS = 30;
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

/** Filesystem identity of a directory or file (dev + ino, as bigints so Windows file ids stay exact). */
export type FsIdentity = { dev: bigint; ino: bigint };

function sameIdentity(a: FsIdentity, b: FsIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Throws unless `dirReal` is still a plain (non-link) directory with identity `id`. */
export function assertDirIdentity(dirReal: string, id: FsIdentity, label: string): void {
  const st = lstatSync(dirReal, { bigint: true, throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isDirectory() || !sameIdentity(st, id)) {
    throw new Error(`${label} ${dirReal} was replaced (symlink/junction or different directory); refusing to use it.`);
  }
}

export type SessionDirResolution =
  | { kind: "ok"; rootReal: string; dirReal: string; dirId: FsIdentity }
  | { kind: "absent"; reason: string }
  | { kind: "rejected"; reason: string };

/** Test-only seams fired after the session dir's lstat and after its realpath. Production never sets them. */
export type SessionDirHooks = {
  afterLstat?: (candidate: string) => void;
  afterRealpath?: (candidate: string, dirReal: string) => void;
};

/**
 * Resolve `<imagesRoot>/<sessionId>` physically. Refuses a session directory
 * that is itself a symlink/junction, and one whose realpath is not a direct
 * child of the images root's realpath. The dev+ino seen by `lstat` must equal
 * the dev+ino of the realpath, so a plain directory swapped for a junction
 * (e.g. to ANOTHER session's directory inside the root) between the two calls
 * is refused rather than followed. The returned `dirId` is re-checked on every
 * later file open.
 */
export function resolveSessionDir(
  imagesRoot: string,
  sessionId: string,
  hooks: SessionDirHooks = {},
): SessionDirResolution {
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
  const st = lstatSync(candidate, { bigint: true, throwIfNoEntry: false });
  if (!st) return { kind: "absent", reason: `no directory exists for session ${sessionId}.` };
  if (st.isSymbolicLink()) {
    return { kind: "rejected", reason: `session directory ${candidate} is a symlink/junction; refusing to follow it.` };
  }
  if (!st.isDirectory()) {
    return { kind: "rejected", reason: `session path ${candidate} is not a directory.` };
  }
  hooks.afterLstat?.(candidate);
  let dirReal: string;
  let realSt;
  try {
    dirReal = realpathSync.native(candidate);
    realSt = lstatSync(dirReal, { bigint: true });
  } catch (err) {
    return { kind: "absent", reason: `session directory vanished: ${(err as Error).message}` };
  }
  hooks.afterRealpath?.(candidate, dirReal);
  if (!isDirectChildReal(rootReal, dirReal)) {
    return { kind: "rejected", reason: `session directory resolves to ${dirReal}, outside images root ${rootReal}.` };
  }
  if (realSt.isSymbolicLink() || !sameIdentity(st, realSt)) {
    return { kind: "rejected", reason: `session directory ${candidate} was replaced between lstat and realpath (symlink/junction swap); refusing it.` };
  }
  // The directory must still BE `<root>/<sessionId>`: an identity-preserving
  // swap (rename the real dir to a sibling, put a link at the old name) keeps
  // dev+ino but resolves under a different name, and leaves a link at the
  // candidate path. Both are refused.
  if (!samePath(basename(dirReal), sessionId)) {
    return { kind: "rejected", reason: `session directory ${candidate} resolves to ${dirReal}, not to itself (renamed and linked?); refusing it.` };
  }
  const again = lstatSync(candidate, { bigint: true, throwIfNoEntry: false });
  if (!again || again.isSymbolicLink() || !again.isDirectory() || !sameIdentity(st, again)) {
    return { kind: "rejected", reason: `session directory ${candidate} is no longer the plain directory first seen; refusing it.` };
  }
  return { kind: "ok", rootReal, dirReal, dirId: { dev: st.dev, ino: st.ino } };
}

// ─── enumeration ─────────────────────────────────────────────────────────────

export type SessionListing = {
  /** Regular files named *.png, sorted. */
  pngNames: string[];
  /** *.png entries that are NOT regular files (symlinks, junctions, directories). */
  nonRegularPngs: string[];
  /** Directory entries examined. Never exceeds `maxEntries`. */
  scanned: number;
  /** True when entries remained after `maxEntries` were examined. */
  truncated: boolean;
  /**
   * Directory entries actually READ: `scanned`, plus the one-entry probe used
   * to detect truncation when it found an entry. Never exceeds `maxEntries + 1`;
   * cumulative budgets are charged with this number, not `scanned`.
   */
  read: number;
};

/**
 * Enumerate at most `maxEntries` entries of `dirReal` WITHOUT following
 * links (`Dirent` types come from the directory itself). Stops early instead
 * of materialising an unbounded listing; one extra entry may be read to learn
 * whether the listing was truncated, and that read is counted in `read`.
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
  return { pngNames, nonRegularPngs, scanned, truncated, read: scanned + (truncated ? 1 : 0) };
}

// ─── verified open / read ────────────────────────────────────────────────────

/** Test-only seams fired around the verified open. Production never sets them. */
export type FileOpenHooks = {
  beforeOpen?: (path: string) => void;
  afterOpen?: (path: string) => void;
  /** Fired after the first fd/path identity check, before realpath. */
  afterFirstCheck?: (path: string) => void;
  afterVerify?: (path: string) => void;
  /** Fired by the caller after reading from the fd, before its post-read check. */
  afterRead?: (path: string) => void;
};

export type VerifiedFile =
  | { ok: true; fd: number; id: FsIdentity; size: number; mtimeMs: number }
  | {
      ok: false;
      reason: string;
      /** True for rejections no amount of waiting can fix (symlink, size cap, escape). */
      terminal: boolean;
      /**
       * Identity of the object that WAS opened, when the open got as far as
       * fstat — set even though the open is rejected, so callers can count it.
       */
      id?: FsIdentity;
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
 *   4. realpath of the path must be a direct child of `dirReal`;
 *   5. LAST, after all resolution: `dirReal` must still be the plain directory
 *      resolved earlier (`dirId`), and an lstat of the path must again match
 *      the fd — so a directory swapped in for the open and restored before
 *      realpath is refused.
 * The caller reads from the returned fd only, so a later swap of the path
 * cannot redirect the read. The caller owns closing the fd.
 */
export function openVerifiedFile(
  dirReal: string,
  dirId: FsIdentity,
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
  let openedId: FsIdentity | undefined;
  const fail = (reason: string, terminal: boolean): VerifiedFile => {
    closeSync(fd);
    return { ok: false, reason, terminal, ...(openedId ? { id: openedId } : {}) };
  };
  try {
    hooks.afterOpen?.(p);
    const st = fstatSync(fd, { bigint: true });
    openedId = { dev: st.dev, ino: st.ino }; // recorded at once: counted even if the open is rejected below
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
    hooks.afterFirstCheck?.(p);
    const real = realpathSync.native(p);
    if (!isDirectChildReal(dirReal, real)) {
      return fail(`file resolves to ${real}, outside the session directory.`, true);
    }
    // Last, and after all resolution: the session dir is still the one
    // resolved earlier, and the PATH still denotes the fd's file. A directory
    // swapped in for the open and restored before realpath fails here.
    try {
      assertDirIdentity(dirReal, dirId, "session directory");
    } catch (err) {
      return fail((err as Error).message, true);
    }
    const again = lstatSync(p, { bigint: true, throwIfNoEntry: false });
    if (!again || again.isSymbolicLink() || again.ino !== st.ino || again.dev !== st.dev) {
      return fail("path no longer denotes the opened file after verification (swapped and restored?); refusing the read.", true);
    }
    hooks.afterVerify?.(p);
    return { ok: true, fd, id: { dev: st.dev, ino: st.ino }, size: Number(st.size), mtimeMs: Number(st.mtimeMs) };
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
  | { ok: true; width: number; height: number; bitDepth: number; colorType: number; interlaced: boolean; rawBytes: number }
  | { ok: false; reason: string };

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const CRITICAL_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);


/** Adam7 pass origins and steps: [x0, y0, dx, dy]. */
const ADAM7: [number, number, number, number][] = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

/**
 * The exact scanline layout the IDAT stream must inflate to, as (rows, bytes
 * per row incl. the filter byte) per pass — one pass when not interlaced,
 * up to seven Adam7 passes when interlaced (empty passes are omitted).
 */
export function pngScanlineLayout(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  interlaced: boolean,
): { rows: number; rowBytes: number }[] {
  const bitsPerPixel = bitDepth * (CHANNELS[colorType] as number);
  const rowBytes = (w: number) => 1 + Math.ceil((w * bitsPerPixel) / 8);
  if (!interlaced) return [{ rows: height, rowBytes: rowBytes(width) }];
  const passes: { rows: number; rowBytes: number }[] = [];
  for (const [x0, y0, dx, dy] of ADAM7) {
    const w = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const h = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    if (w > 0 && h > 0) passes.push({ rows: h, rowBytes: rowBytes(w) });
  }
  return passes;
}

/**
 * Validate the WHOLE PNG before any file is accepted — including the
 * fits-as-is verbatim copy:
 *   - signature; first chunk IHDR, length 13, legal dimensions / colour type /
 *     bit depth / methods; IHDR dimensions within `maxPixels` (checked BEFORE
 *     any inflation);
 *   - every chunk's length in bounds and CRC correct; ONLY the four critical
 *     chunks IHDR, PLTE, IDAT and IEND are accepted — ANY ancillary chunk
 *     (gAMA, tEXt, iCCP, eXIf, …) refuses the file, so no metadata payload
 *     ever has to be trusted; IHDR, PLTE and IEND at most once; PLTE before
 *     IDAT, required for palette images and forbidden for greyscale(+alpha);
 *     at least one IDAT (with only critical chunks allowed, IDATs are
 *     necessarily consecutive: anything after them is IEND or refused);
 *   - a final zero-length IEND with no trailing bytes;
 *   - the concatenated IDAT stream inflates — with `maxOutputLength` set to
 *     the exact size IHDR implies, so a decompression bomb stops at that bound —
 *     to EXACTLY that size (unused padding after the zlib stream is ignored,
 *     per PNG §11.2.3), and every scanline's
 *     filter byte is 0..4.
 * Because the image data is proven to inflate to exactly the declared layout,
 * a later pngjs decode of the same bytes is bounded by the same size.
 */
export function validatePngStructure(buf: Buffer, maxPixels: number = MAX_DECODED_PIXELS_PER_IMAGE): PngStructure {
  if (buf.length < PNG_SIGNATURE.length || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ok: false, reason: "missing PNG signature." };
  }
  let off = 8;
  let index = 0;
  let ihdr: { width: number; height: number; bitDepth: number; colorType: number; interlaced: boolean } | undefined;
  const idat: Buffer[] = [];
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
    // An uppercase first letter marks a CRITICAL chunk: a decoder that does not
    // know it must refuse the image, so we refuse it too.
    if (/^[A-Z]/.test(type) && !CRITICAL_CHUNKS.has(type)) {
      return { ok: false, reason: `unknown critical chunk ${type} at byte ${off}.` };
    }
    // Lowercase first letter = ANCILLARY. None is accepted: the harvester
    // passes on only what it fully validates, and it does not validate
    // metadata payloads.
    if (!CRITICAL_CHUNKS.has(type)) {
      return { ok: false, reason: `${type} chunk at byte ${off}: ancillary chunks are not accepted (only IHDR, PLTE, IDAT and IEND).` };
    }
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
      if (width * height > maxPixels) {
        return { ok: false, reason: `exceeds decoded pixel budget (${width}x${height} > ${maxPixels}px cap); not inflated.` };
      }
      if (!VALID_BIT_DEPTHS[colorType]?.includes(bitDepth)) {
        return { ok: false, reason: `IHDR colour type ${colorType} / bit depth ${bitDepth} is not a legal combination.` };
      }
      if (buf[d + 10] !== 0 || buf[d + 11] !== 0 || (buf[d + 12] as number) > 1) {
        return { ok: false, reason: "IHDR compression/filter/interlace method is invalid." };
      }
      ihdr = { width, height, bitDepth, colorType, interlaced: buf[d + 12] === 1 };
    } else if (type === "PLTE") {
      if (sawPlte) return { ok: false, reason: "more than one PLTE chunk." };
      if (idat.length > 0) return { ok: false, reason: "PLTE after IDAT." };
      if (ihdr?.colorType === 0 || ihdr?.colorType === 4) return { ok: false, reason: "PLTE in a greyscale image." };
      if (len === 0 || len % 3 !== 0 || len > 768) return { ok: false, reason: `PLTE length ${len} is invalid.` };
      if (ihdr?.colorType === 3 && len / 3 > 2 ** ihdr.bitDepth) {
        return { ok: false, reason: `PLTE has ${len / 3} entries; bit depth ${ihdr.bitDepth} allows at most ${2 ** ihdr.bitDepth}.` };
      }
      sawPlte = true;
    } else if (type === "IDAT") {
      if (ihdr?.colorType === 3 && !sawPlte) return { ok: false, reason: "palette image has IDAT before PLTE." };
      idat.push(buf.subarray(off + 8, off + 8 + len));
    } else if (type === "IEND") {
      if (len !== 0) return { ok: false, reason: "IEND chunk has a non-zero length." };
      sawIend = true;
    }
    off = end;
    index += 1;
  }
  if (!ihdr) return { ok: false, reason: "no IHDR chunk." };
  if (idat.length === 0) return { ok: false, reason: "no IDAT chunk." };
  if (!sawIend) return { ok: false, reason: "no IEND chunk (truncated)." };

  const layout = pngScanlineLayout(ihdr.width, ihdr.height, ihdr.bitDepth, ihdr.colorType, ihdr.interlaced);
  const rawBytes = layout.reduce((acc, p) => acc + p.rows * p.rowBytes, 0);
  const stream = Buffer.concat(idat);
  let raw: Buffer;
  try {
    // Unused bytes after the end of the zlib stream (padding in the final
    // IDAT) are legal — PNG §11.2.3 says decoders ignore them — so they are
    // not refused; a TRUNCATED zlib stream still throws here.
    raw = zlib.inflateSync(stream, { maxOutputLength: rawBytes });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ERR_BUFFER_TOO_LARGE"
      ? { ok: false, reason: `IDAT data inflates past the ${rawBytes} bytes IHDR implies (decompression bomb); not decoded.` }
      : { ok: false, reason: `IDAT data does not inflate (${code ?? (err as Error).message}).` };
  }
  if (raw.length !== rawBytes) {
    return { ok: false, reason: `IDAT data inflates to ${raw.length} bytes; IHDR implies exactly ${rawBytes}.` };
  }
  let pos = 0;
  for (const p of layout) {
    for (let r = 0; r < p.rows; r++, pos += p.rowBytes) {
      if ((raw[pos] as number) > 4) return { ok: false, reason: `invalid scanline filter type ${raw[pos]} at inflated byte ${pos}.` };
    }
  }
  return { ok: true, ...ihdr, rawBytes };
}

export type AcceptedPng =
  | { ok: true; structure: Extract<PngStructure, { ok: true }>; decoded: PNG }
  | { ok: false; reason: string };

/**
 * The acceptance gate for EVERY harvested file, including one copied
 * verbatim: `validatePngStructure` (container rules, pixel cap, inflation
 * bounded to the IHDR-implied size), then a full decode by the same decoder
 * the downscale path uses. The decode reconstructs filtered scanlines and
 * rejects what structure alone cannot prove — e.g. a palette index outside
 * PLTE — and it is bounded because the bytes were just proven to inflate to
 * exactly the IHDR size.
 */
export function acceptPng(buf: Buffer, maxPixels: number = MAX_DECODED_PIXELS_PER_IMAGE): AcceptedPng {
  const structure = validatePngStructure(buf, maxPixels);
  if (!structure.ok) return structure;
  let decoded: PNG;
  try {
    decoded = PNG.sync.read(buf);
  } catch (err) {
    return { ok: false, reason: `does not decode: ${(err as Error).message}` };
  }
  if (decoded.width !== structure.width || decoded.height !== structure.height) {
    return { ok: false, reason: `decoded ${decoded.width}x${decoded.height}, IHDR declares ${structure.width}x${structure.height}.` };
  }
  return { ok: true, structure, decoded };
}

/** Cheap completeness hint used while polling: does the file end with the IEND chunk? */
export function hasPngTrailer(fd: number, size: number): boolean {
  if (size < PNG_SIGNATURE.length + IEND_CHUNK.length) return false;
  const tail = Buffer.alloc(IEND_CHUNK.length);
  const n = readSync(fd, tail, 0, tail.length, size - tail.length);
  return n === tail.length && tail.equals(IEND_CHUNK);
}

// ─── settle polling ──────────────────────────────────────────────────────────

/** What a poll saw of one file: its identity, size and mtime (from the verified fd). */
export type FileObservation = { dev: bigint; ino: bigint; size: number; mtimeMs: number };

function sameObservation(a: FileObservation, b: FileObservation): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Throws unless the freshly verified fd `v` is the very file a settle poll
 * observed (same dev+ino, size and mtime). Called at the final open, so a
 * settled file swapped for another — even a complete PNG with a fresh mtime —
 * is refused instead of being accepted without two settle observations.
 */
export function assertMatchesObservation(v: { id: FsIdentity; size: number; mtimeMs: number }, obs: FileObservation): void {
  if (!sameObservation({ ...v.id, size: v.size, mtimeMs: v.mtimeMs }, obs)) {
    throw new Error("file changed since it settled (different identity, size or mtime); refusing it.");
  }
}

/** Throws unless the fd still shows the observed size and mtime after the read. */
export function assertFdUnchanged(fd: number, obs: FileObservation): void {
  const st = fstatSync(fd, { bigint: true });
  if (st.dev !== obs.dev || st.ino !== obs.ino || Number(st.size) !== obs.size || Number(st.mtimeMs) !== obs.mtimeMs) {
    throw new Error("file changed while it was being read; refusing it.");
  }
}

export type SettleOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  maxImages?: number;
  maxEntriesPerPoll?: number;
  maxEntriesPerCall?: number;
  maxOpensPerCall?: number;
  maxBytes?: number;
  maxPolls?: number;
  /** Test-only seam: replaces the inter-poll sleep (e.g. to simulate a timer firing late). */
  sleep?: (ms: number) => Promise<void>;
  /** Test-only seam: hooks around each verified open made while polling. */
  fileHooks?: FileOpenHooks;
};

export type SettledHarvest =
  | { kind: "rejected"; reason: string }
  | { kind: "absent"; reason: string }
  | {
      kind: "ok";
      dirReal: string;
      /** Identity of the session dir as resolved; every later open re-checks it. */
      dirId: FsIdentity;
      /** Identical observation on two consecutive polls AND ending in IEND; `obs` is bound to the final read. */
      settled: { name: string; obs: FileObservation }[];
      /** Still changing or incomplete when polling stopped (deadline or budget). */
      unsettled: { name: string; reason: string }[];
      /** Refused by the verified open (symlink, size cap, replaced, escape) or not a regular file. */
      rejected: { name: string; reason: string }[];
      /** Regular PNGs beyond the per-call distinct-image cap; never opened. */
      overCap: string[];
      /** Entries visited by the last poll (never more than the per-poll cap). */
      scanned: number;
      /** True when the last poll stopped with entries remaining. */
      truncated: boolean;
      /** Directory entries READ across ALL polls of this call, truncation probes included. */
      entriesExamined: number;
      /** File opens across ALL polls of this call. */
      opens: number;
      /** Polls performed (never more than the poll cap). */
      polls: number;
      /** When the last poll started; never after `deadlineMs`. */
      lastPollStartMs: number;
      deadlineMs: number;
      /** Set when a cumulative per-call budget stopped polling early. */
      budgetExhausted?: "entries" | "opens";
    };

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Wait (bounded) for the session directory's PNGs to settle. A file is settled
 * when the verified fd shows the same dev+ino, size and mtime on two
 * consecutive polls AND it ends with an IEND chunk. That observation is
 * returned and must match again at the final read (`assertMatchesObservation`).
 *
 * Budgets are CUMULATIVE for the whole call, not per poll:
 *   - at most `maxEntriesPerPoll` (200) entries per enumeration and
 *     `maxEntriesPerCall` (1000) across all polls;
 *   - at most `maxImages` (20) DISTINCT PNG names are ever opened — the first
 *     ones seen, in sorted order — and the rest are reported, never opened;
 *     each name is bound to the first file identity seen under it and refused
 *     if that identity changes, so at most 2 x 20 distinct files are opened;
 *   - at most `maxOpensPerCall` (180) file opens across all polls, leaving at
 *     most 20 more for the final reads (≤ 200 opens per call in total).
 * Exhausting a budget stops polling; files not yet settled are reported.
 * Rejections that waiting cannot fix are reported immediately and never retried.
 */
export async function pollForSettledPngs(
  imagesRoot: string,
  sessionId: string,
  opts: SettleOptions = {},
): Promise<SettledHarvest> {
  const timeoutMs = opts.timeoutMs ?? HARVEST_POLL_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? HARVEST_POLL_INTERVAL_MS;
  const maxImages = opts.maxImages ?? MAX_IMAGES_PER_CALL;
  const maxEntriesPerPoll = opts.maxEntriesPerPoll ?? MAX_DIR_ENTRIES_SCANNED;
  const maxEntriesPerCall = opts.maxEntriesPerCall ?? MAX_DIR_ENTRIES_PER_CALL;
  const maxOpensPerCall = opts.maxOpensPerCall ?? MAX_POLL_OPENS_PER_CALL;
  const maxBytes = opts.maxBytes ?? MAX_SOURCE_BYTES;
  const maxPolls = opts.maxPolls ?? MAX_SETTLE_POLLS;
  const deadline = Date.now() + timeoutMs;
  let prev = new Map<string, FileObservation>();
  const rejected = new Map<string, string>();
  const chosen = new Set<string>();
  const firstIds = new Map<string, FsIdentity>();
  let entriesExamined = 0;
  let opens = 0;
  let polls = 0;
  let lastPollStartMs = 0;
  // Stop after this poll if the poll cap is reached, or if the NEXT poll
  // would start after the deadline: no poll ever starts after `deadline`.
  const noFurtherPoll = (): boolean => polls >= maxPolls || Date.now() + intervalMs > deadline;
  let lastOutcome: SettledHarvest | undefined;

  for (;;) {
    polls += 1;
    lastPollStartMs = Date.now();
    const res = resolveSessionDir(imagesRoot, sessionId);
    if (res.kind === "rejected") return res;
    if (res.kind === "ok") {
      // Leave room for the one-entry truncation probe so that every entry
      // READ — probe included — fits the cumulative per-call budget.
      const listing = listSessionEntries(res.dirReal, Math.min(maxEntriesPerPoll, maxEntriesPerCall - entriesExamined - 1));
      entriesExamined += listing.read;
      for (const n of listing.nonRegularPngs) rejected.set(n, "not a regular file (symlink, junction or directory).");
      const overCap: string[] = [];
      for (const n of listing.pngNames) {
        if (chosen.has(n)) continue;
        if (chosen.size < maxImages) chosen.add(n);
        else overCap.push(n);
      }
      const tracked = listing.pngNames.filter(n => chosen.has(n));
      const seen = new Map<string, FileObservation>();
      const pending = new Map<string, string>();
      let budgetExhausted: "entries" | "opens" | undefined;
      for (const name of tracked) {
        if (rejected.has(name)) continue;
        if (opens >= maxOpensPerCall) {
          budgetExhausted = "opens";
          pending.set(name, `per-call open budget (${maxOpensPerCall}) exhausted before it settled.`);
          continue;
        }
        opens += 1;
        const v = openVerifiedFile(res.dirReal, res.dirId, name, maxBytes, opts.fileHooks);
        // Each chosen NAME is bound to the first object identity ever OPENED
        // under it — recorded straight after fstat, including opens that are
        // then rejected — and a different object under that name is refused
        // terminally, so at most two distinct objects are ever opened per name.
        if (v.id) {
          const first = firstIds.get(name);
          if (first && !sameIdentity(first, v.id)) {
            if (v.ok) closeSync(v.fd);
            rejected.set(name, "replaced by a different file while polling (identity changed since first seen); refused.");
            continue;
          }
          if (!first) firstIds.set(name, v.id);
        }
        if (!v.ok) {
          if (v.terminal) rejected.set(name, v.reason);
          else pending.set(name, v.reason);
          continue;
        }
        try {
          seen.set(name, { ...v.id, size: v.size, mtimeMs: v.mtimeMs });
          if (!hasPngTrailer(v.fd, v.size)) pending.set(name, "no IEND trailer yet (incomplete or malformed PNG).");
        } finally {
          closeSync(v.fd);
        }
      }
      // Another poll needs room for at least one entry plus the probe.
      if (!budgetExhausted && maxEntriesPerCall - entriesExamined < 2) budgetExhausted = "entries";
      const live = tracked.filter(n => !rejected.has(n));
      const settled = live.filter(n => {
        const a = seen.get(n);
        const b = prev.get(n);
        return !pending.has(n) && a !== undefined && b !== undefined && sameObservation(a, b);
      });
      const done = tracked.length > 0 && settled.length === live.length;
      const why = budgetExhausted
        ? `polling stopped: per-call ${budgetExhausted === "entries" ? `directory-entry budget (${maxEntriesPerCall})` : `open budget (${maxOpensPerCall})`} exhausted`
        : `did not settle within ${timeoutMs}ms / ${maxPolls} polls`;
      const outcome: SettledHarvest = {
          kind: "ok",
          dirReal: res.dirReal,
          dirId: res.dirId,
          settled: settled.map(name => ({ name, obs: seen.get(name) as FileObservation })),
          unsettled: live
            .filter(n => !settled.includes(n))
            .map(name => ({ name, reason: `${why}: ${pending.get(name) ?? "identity/size/mtime still changing."}` })),
          rejected: [...rejected].map(([name, reason]) => ({ name, reason })),
          overCap,
          scanned: listing.scanned,
          truncated: listing.truncated,
          entriesExamined,
          opens,
          polls,
          lastPollStartMs,
          deadlineMs: deadline,
          ...(budgetExhausted ? { budgetExhausted } : {}),
        };
      if (done || budgetExhausted || noFurtherPoll()) return outcome;
      lastOutcome = outcome;
      prev = seen;
    } else {
      if (noFurtherPoll()) return res;
      lastOutcome = res;
    }
    await (opts.sleep ?? sleep)(intervalMs);
    // A timer can fire late under load: never START a poll after the deadline —
    // report the previous poll's outcome instead.
    if (Date.now() > deadline && lastOutcome) return lastOutcome;
  }
}


// ─── output ──────────────────────────────────────────────────────────────────

export type OutputDirResolution =
  | { ok: true; outReal: string; /** Identity of output_dir; every write re-checks it. */ outId: FsIdentity }
  | { ok: false; reason: string };

/** Test-only seams for staging a swap at an exact point. Production never sets them. */
export type OutputDirHooks = {
  afterCreate?: (dir: string) => void;
  beforeFinalCheck?: () => void;
};

/**
 * Create (if needed) and physically resolve `outputDir`.
 *
 * The nearest EXISTING ancestor is the caller's choice and may itself be a
 * link (macOS /tmp); its realpath and identity are pinned once. Every
 * component this call creates is then made one level at a time, and before
 * each mkdir its parent must still be the pinned/created directory (same
 * dev+ino, not a link) — so an intermediate component swapped for a junction
 * stops the walk before anything is created through it. After the walk, every
 * created component must still carry its recorded identity, output_dir itself
 * must not be a link, and realpath(output_dir) must equal the pinned ancestor
 * realpath joined with the created names; any swap that slipped between a
 * check and a mkdir is caught there.
 */
export function prepareOutputDir(outputDir: string, hooks: OutputDirHooks = {}): OutputDirResolution {
  const abs = resolve(outputDir);
  const toCreate: string[] = [];
  let ancestor = abs;
  for (;;) {
    if (lstatSync(ancestor, { throwIfNoEntry: false })) break;
    const parent = dirname(ancestor);
    if (parent === ancestor) return { ok: false, reason: `no existing ancestor for output_dir ${abs}.` };
    toCreate.unshift(ancestor);
    if (toCreate.length > MAX_CREATED_OUTPUT_COMPONENTS) {
      return { ok: false, reason: `output_dir would create more than ${MAX_CREATED_OUTPUT_COMPONENTS} directories.` };
    }
    ancestor = parent;
  }
  if (toCreate.length === 0) {
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st) return { ok: false, reason: `output_dir ${abs} vanished.` };
    if (st.isSymbolicLink()) return { ok: false, reason: `output_dir ${abs} is a symlink/junction; refusing to write through it.` };
    if (!st.isDirectory()) return { ok: false, reason: `output_dir ${abs} is not a directory.` };
  }
  let ancestorReal: string;
  let ancestorId: FsIdentity;
  try {
    ancestorReal = realpathSync.native(ancestor);
    const st = lstatSync(ancestorReal, { bigint: true });
    if (!st.isDirectory()) return { ok: false, reason: `output_dir ancestor ${ancestor} is not a directory.` };
    ancestorId = { dev: st.dev, ino: st.ino };
  } catch (err) {
    return { ok: false, reason: `could not resolve output_dir ancestor ${ancestor}: ${(err as Error).message}` };
  }

  const created: { path: string; id: FsIdentity }[] = [];
  try {
    for (const dir of toCreate) {
      const parent = created.at(-1);
      if (parent) {
        assertDirIdentity(parent.path, parent.id, "created output component");
      } else if (!samePath(realpathSync.native(ancestor), ancestorReal)) {
        throw new Error(`output_dir ancestor ${ancestor} no longer resolves to ${ancestorReal}; refusing to create under it.`);
      } else {
        assertDirIdentity(ancestorReal, ancestorId, "output_dir ancestor");
      }
      try {
        mkdirSync(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const st = lstatSync(dir, { bigint: true, throwIfNoEntry: false });
      if (!st || st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`created output component ${dir} is not a plain directory (symlink/junction swap?).`);
      }
      created.push({ path: dir, id: { dev: st.dev, ino: st.ino } });
      hooks.afterCreate?.(dir);
    }
    hooks.beforeFinalCheck?.();
    for (const c of created) assertDirIdentity(c.path, c.id, "created output component");
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  let outReal: string;
  let outId: FsIdentity;
  try {
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink() || !st.isDirectory()) {
      return { ok: false, reason: `output_dir ${abs} is not a plain directory (symlink/junction?).` };
    }
    outReal = realpathSync.native(abs);
    const realSt = lstatSync(outReal, { bigint: true });
    outId = { dev: realSt.dev, ino: realSt.ino };
  } catch (err) {
    return { ok: false, reason: `could not resolve output_dir ${abs}: ${(err as Error).message}` };
  }
  const expected = join(ancestorReal, relative(ancestor, abs));
  if (!samePath(outReal, expected)) {
    return { ok: false, reason: `output_dir resolves to ${outReal}, not ${expected} (a component was swapped for a link).` };
  }
  return { ok: true, outReal, outId };
}

/**
 * Throws unless `outReal` is still the directory `prepareOutputDir` resolved.
 * Resolution FIRST (its realpath must be itself), identity LAST (a plain,
 * non-link directory whose dev+ino is `outId`), so a directory swapped in
 * during the realpath call is still caught. A different plain directory put
 * at the same path — directly or by replacing an ancestor — has a different
 * identity and is refused.
 */
export function assertOutputDirIntact(outReal: string, outId: FsIdentity): void {
  let resolved: string;
  try {
    resolved = realpathSync.native(outReal);
  } catch (err) {
    throw new Error(`output_dir ${outReal} no longer resolves (${(err as Error).message}); refusing to write.`);
  }
  if (!samePath(resolved, outReal)) {
    throw new Error(`output_dir ${outReal} no longer resolves to itself; refusing to write.`);
  }
  assertOutputDirIdentity(outReal, outId);
}

function assertOutputDirIdentity(outReal: string, outId: FsIdentity): void {
  const st = lstatSync(outReal, { bigint: true, throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`output_dir ${outReal} is no longer a plain directory (symlink/junction swap?); refusing to write.`);
  }
  if (!sameIdentity(st, outId)) {
    throw new Error(`output_dir ${outReal} was replaced by a different directory; refusing to write.`);
  }
}

/** Test-only seams around staging, hand-off and verification. Production never sets them. */
export type WriteHooks = {
  /** Fired after the bytes are written to the STAGED file, before its verification. */
  afterWrite?: (stagedPath: string) => void;
  /** Fired between the first identity check and the realpath resolution (staging and hand-off verification). */
  duringVerify?: (path: string) => void;
  /** Fired after every realpath resolution, before the final identity checks. */
  afterResolve?: (path: string) => void;
  /** Fired immediately before the exclusive hand-off into output_dir. */
  beforeHandOff?: (dest: string) => void;
  /** Fired immediately after the exclusive hand-off, before its verification. */
  afterHandOff?: (dest: string) => void;
  /** Fired after a failed verification, before the fd-bound neutralisation. */
  beforeNeutralise?: (path: string) => void;
  /** Replaces ftruncateSync so a test can force the neutralisation to fail. */
  truncate?: (fd: number, len: number) => void;
  /** Force the hard-link hand-off to fail with this error code (e.g. EXDEV). */
  linkError?: string;
};

function assertIsWrittenFile(dest: string, fileId: FsIdentity, size: number): void {
  const st = lstatSync(dest, { bigint: true, throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isFile() || !sameIdentity(st, fileId)) {
    throw new Error(`${dest} is no longer the file that was written (replaced or linked); refusing to report it.`);
  }
  if (st.size !== BigInt(size)) {
    throw new Error(`${dest} has ${st.size} bytes; ${size} were written.`);
  }
}

/**
 * Prove `dest` denotes the file created through the fd, directly inside the
 * directory `dirReal` (identity `dirId`):
 *   1. lstat: non-link regular file with the fd's dev+ino and `size` bytes;
 *   2. ALL resolution: realpath(dest) must be a direct child of `dirReal`, and
 *      realpath(dirReal) must be `dirReal` itself;
 *   3. LAST, no further resolution: the file identity/size check again, then
 *      the directory's identity.
 * Returns the file's realpath; throws otherwise.
 */
export function verifyWrittenPath(
  dirReal: string,
  dirId: FsIdentity,
  dest: string,
  fileId: FsIdentity,
  size: number,
  hooks: WriteHooks = {},
  label = "output_dir",
): string {
  assertIsWrittenFile(dest, fileId, size);
  hooks.duringVerify?.(dest);
  const real = realpathSync.native(dest);
  if (!isDirectChildReal(dirReal, real)) {
    throw new Error(`written file resolves to ${real}, outside ${label} ${dirReal}.`);
  }
  if (!samePath(realpathSync.native(dirReal), dirReal)) {
    throw new Error(`${label} ${dirReal} no longer resolves to itself; refusing to report the write.`);
  }
  hooks.afterResolve?.(dest);
  assertIsWrittenFile(dest, fileId, size);
  assertDirIdentity(dirReal, dirId, label);
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
 * Truncate OUR object through its still-open fd after a failed check, and
 * throw an error that reports honestly whether that worked. Nothing is ever
 * deleted by pathname (a path-based unlink cannot be bound to the object we
 * created and could remove a file someone else put there).
 */
function neutraliseAndThrow(fd: number, path: string, err: unknown, hooks: WriteHooks): never {
  hooks.beforeNeutralise?.(path);
  let cleanup: string;
  try {
    (hooks.truncate ?? ftruncateSync)(fd, 0);
    cleanup = "the bytes of the file this call created were truncated through its fd; an empty file may remain";
  } catch (truncErr) {
    cleanup =
      `truncating our bytes through the fd FAILED (${(truncErr as NodeJS.ErrnoException).code ?? (truncErr as Error).message}); ` +
      "the content of the file this call created is UNKNOWN and may remain wherever it now lives";
  }
  throw new Error(`${(err as Error).message} (${cleanup}.)`);
}

// ─── private staging ─────────────────────────────────────────────────────────

/** A per-call, daemon-owned directory where content is written and verified before any hand-off. */
export type StagingDir = { dirReal: string; id: FsIdentity };

/** Test-only seam fired right after the staging directory is allocated. Production never sets it. */
export type StagingHooks = { afterMkdtemp?: (dir: string) => void };

/**
 * Create the per-call staging directory under the daemon-owned `parent`
 * (PP_HOME/.pair-programmer/image-staging): `mkdtemp`, mode 0700 on POSIX.
 * Refused if `parent` or the new directory is a link, if the new directory's
 * realpath is not a direct child of the parent's, or if its identity changes
 * between lstat and realpath.
 *
 * Nothing is ever deleted during a call: the staging directory (and anything
 * staged in it) is RETAINED by design when the call ends, and is removed later
 * only by the conservative `sweepStagingDirs` once stale. If setup fails after
 * the directory was allocated, that directory is likewise retained and the
 * returned reason names it.
 */
export function createStagingDir(
  parent: string,
  hooks: StagingHooks = {},
): { ok: true; staging: StagingDir } | { ok: false; reason: string } {
  let allocated: string | undefined;
  // Nothing is deleted during a call, not even on this failure path: a
  // directory already allocated is retained, reported, and left for the
  // conservative sweep (`sweepStagingDirs`).
  const fail = (reason: string): { ok: false; reason: string } =>
    allocated === undefined
      ? { ok: false, reason }
      : { ok: false, reason: `${reason} The staging directory it had allocated (${allocated}) is retained by design and will be swept once stale.` };
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const pst = lstatSync(parent);
    if (pst.isSymbolicLink() || !pst.isDirectory()) return fail(`staging parent ${parent} is not a plain directory.`);
    const parentReal = realpathSync.native(parent);
    allocated = mkdtempSync(join(parentReal, "gi-"));
    hooks.afterMkdtemp?.(allocated);
    if (process.platform !== "win32") chmodSync(allocated, 0o700);
    const st = lstatSync(allocated, { bigint: true });
    if (st.isSymbolicLink() || !st.isDirectory()) return fail(`staging directory ${allocated} is not a plain directory.`);
    const dirReal = realpathSync.native(allocated);
    if (!isDirectChildReal(parentReal, dirReal)) return fail(`staging directory resolves to ${dirReal}, outside ${parentReal}.`);
    const id = { dev: st.dev, ino: st.ino };
    assertDirIdentity(dirReal, id, "staging directory");
    return { ok: true, staging: { dirReal, id } };
  } catch (err) {
    return fail(`could not create the staging directory: ${(err as Error).message}.`);
  }
}

/** Throws unless the staging directory still resolves to itself and keeps its identity (resolution first, identity last). */
export function assertStagingIntact(s: StagingDir): void {
  if (!samePath(realpathSync.native(s.dirReal), s.dirReal)) {
    throw new Error(`staging directory ${s.dirReal} no longer resolves to itself; refusing to use it.`);
  }
  assertDirIdentity(s.dirReal, s.id, "staging directory");
}

/** Staging directories older than this (by mtime) are swept at the start of a later call. */
export const STAGING_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * At most this many entries are READ from any one directory listing during a
 * sweep (the staging parent, or one staging directory). A staging directory
 * whose listing reaches the bound is skipped and left in place — no extra
 * entry is read to find out whether there are more.
 */
export const MAX_SWEEP_ENTRIES = 200;

/** Test-only seam fired right after a path has been observed (lstat) and before it is moved aside. */
export type SweepHooks = { afterObserve?: (path: string) => void };

export type SweepReport = {
  /** Stale staging directories removed (original paths). */
  removed: string[];
  /** Paths the sweep did not delete, and why. Each is also logged. */
  skipped: { path: string; reason: string }[];
};

/** Thrown when a directory the sweep is working in no longer is the directory it bound: the WHOLE sweep stops. */
class SweepAbort extends Error {}

/** Resolution first, identity last: `dirReal` must still resolve to itself and be the plain directory `id`. */
function assertBoundDir(dirReal: string, id: FsIdentity, label: string): void {
  let resolved: string;
  try {
    resolved = realpathSync.native(dirReal);
  } catch (err) {
    throw new SweepAbort(`${label} ${dirReal} no longer resolves (${(err as Error).message}).`);
  }
  if (!samePath(resolved, dirReal)) throw new SweepAbort(`${label} ${dirReal} no longer resolves to itself.`);
  try {
    assertDirIdentity(dirReal, id, label);
  } catch (err) {
    throw new SweepAbort((err as Error).message);
  }
}

/**
 * Remove STALE per-call staging directories (`gi-*`, mtime older than
 * `maxAgeMs`) under the daemon-owned staging parent — conservatively, and
 * never during the call that created them.
 *
 * Bound directories: the staging parent's realpath and dev+ino are bound once,
 * and so is each staging directory once it has been moved aside; BOTH are
 * re-checked (resolution first, identity last) immediately before every
 * rename, unlink and rmdir. If either was replaced — e.g. by a link — the
 * WHOLE sweep stops (fail closed): nothing further is renamed or deleted.
 *
 * Nothing is deleted that was not verified AFTER it was moved: each directory,
 * then each file inside it, is first observed (lstat: non-link, plain
 * directory / regular file, dev+ino), then renamed aside under a fresh random
 * name, and the renamed path must still carry the observed identity — so an
 * object swapped in after the observation is caught (it is what got moved)
 * and is skipped, logged and left in place, never deleted. Links, unexpected
 * entry types, listings that reach MAX_SWEEP_ENTRIES and any error also skip
 * that directory. Directories are removed with `rmdir`, which refuses
 * anything but an empty directory.
 *
 * Residual (stated, operator-accepted): Node has no handle-bound rename,
 * unlink or rmdir, so a same-user process swapping a path inside the
 * daemon-private staging parent (0700 on POSIX) in the instant between a
 * re-check and the following syscall is not excluded.
 */
export function sweepStagingDirs(
  parent: string,
  maxAgeMs: number = STAGING_SWEEP_AGE_MS,
  hooks: SweepHooks = {},
  now: number = Date.now(),
): SweepReport {
  const report: SweepReport = { removed: [], skipped: [] };
  const skip = (path: string, reason: string): void => {
    report.skipped.push({ path, reason });
    log.warn({ path, reason }, "generate_image staging sweep skipped a path (nothing deleted)");
  };
  const pst = lstatSync(parent, { bigint: true, throwIfNoEntry: false });
  if (!pst) return report;
  if (pst.isSymbolicLink() || !pst.isDirectory()) {
    skip(parent, "staging parent is not a plain directory.");
    return report;
  }
  let parentReal: string;
  try {
    parentReal = realpathSync.native(parent);
  } catch (err) {
    skip(parent, `could not resolve the staging parent: ${(err as Error).message}`);
    return report;
  }
  const parentId = { dev: pst.dev, ino: pst.ino };
  let names: string[];
  try {
    assertBoundDir(parentReal, parentId, "staging parent");
    names = boundedNames(parentReal, MAX_SWEEP_ENTRIES).filter(n => n.startsWith("gi-"));
  } catch (err) {
    skip(parent, `could not list the staging parent: ${(err as Error).message}`);
    return report;
  }
  for (const name of names) {
    const dir = join(parentReal, name);
    try {
      sweepOne(parentReal, parentId, dir, maxAgeMs, now, hooks, report, skip);
    } catch (err) {
      if (err instanceof SweepAbort) {
        skip(dir, `sweep STOPPED (fail closed): ${err.message} Nothing further was renamed or deleted.`);
        return report;
      }
      skip(dir, `sweep error: ${(err as Error).message}`);
    }
  }
  return report;
}

/** Read at most `max` entry names from `dirReal` — never more, not even a probe. */
export function boundedNames(dirReal: string, max: number): string[] {
  const out: string[] = [];
  const dir = opendirSync(dirReal);
  try {
    while (out.length < max) {
      const ent = dir.readSync();
      if (ent === null) break;
      out.push(ent.name);
    }
  } finally {
    dir.closeSync();
  }
  return out;
}

function sweepOne(
  parentReal: string,
  parentId: FsIdentity,
  dir: string,
  maxAgeMs: number,
  now: number,
  hooks: SweepHooks,
  report: SweepReport,
  skip: (path: string, reason: string) => void,
): void {
  const st = lstatSync(dir, { bigint: true, throwIfNoEntry: false });
  if (!st) return;
  if (st.isSymbolicLink() || !st.isDirectory()) return skip(dir, "not a plain directory (link or other type); left in place.");
  if (now - Number(st.mtimeMs) < maxAgeMs) return; // not stale yet
  const dirId = { dev: st.dev, ino: st.ino };
  hooks.afterObserve?.(dir);
  const moved = join(parentReal, `sweep-${randomUUID()}`);
  assertBoundDir(parentReal, parentId, "staging parent");
  renameSync(dir, moved);
  const mst = lstatSync(moved, { bigint: true, throwIfNoEntry: false });
  if (!mst || mst.isSymbolicLink() || !mst.isDirectory() || !sameIdentity(mst, dirId)) {
    return skip(moved, `the object at ${dir} was replaced after it was observed; it was moved aside to ${moved} and left in place.`);
  }
  const bound = (): void => {
    assertBoundDir(parentReal, parentId, "staging parent");
    assertBoundDir(moved, dirId, "staging directory being swept");
  };
  bound();
  const entries = boundedNames(moved, MAX_SWEEP_ENTRIES);
  if (entries.length >= MAX_SWEEP_ENTRIES) return skip(moved, `listing reached ${MAX_SWEEP_ENTRIES} entries; left in place.`);
  for (const e of entries) {
    const p = join(moved, e);
    const fst = lstatSync(p, { bigint: true, throwIfNoEntry: false });
    if (!fst) continue;
    if (fst.isSymbolicLink() || !fst.isFile()) return skip(p, "not a regular file; directory left in place.");
    const fileId = { dev: fst.dev, ino: fst.ino };
    hooks.afterObserve?.(p);
    const aside = join(moved, `del-${randomUUID()}`);
    bound();
    renameSync(p, aside);
    const ast = lstatSync(aside, { bigint: true, throwIfNoEntry: false });
    if (!ast || ast.isSymbolicLink() || !ast.isFile() || !sameIdentity(ast, fileId)) {
      return skip(aside, `the file at ${p} was replaced after it was observed; it was moved aside to ${aside} and left in place.`);
    }
    bound();
    unlinkSync(aside);
  }
  bound();
  rmdirSync(moved);
  report.removed.push(dir);
}

export type StagedFile = { path: string; fd: number; id: FsIdentity };

/**
 * Write `buffer` into a fresh, exclusively-created file inside the private
 * staging directory, then prove — before any hand-off — that the path still
 * denotes that file inside staging (identity, size, realpath) and that the
 * bytes read back through the fd equal `buffer`. On failure our object is
 * truncated through its fd and the error says whether that worked. The fd is
 * returned open; the caller closes it.
 */
export function stageImage(staging: StagingDir, name: string, buffer: Buffer, hooks: WriteHooks = {}): StagedFile {
  assertStagingIntact(staging);
  const path = join(staging.dirReal, `${randomUUID()}-${safeOutputName(name)}`);
  const fd = openSync(path, "wx+");
  try {
    const fst = fstatSync(fd, { bigint: true });
    const id = { dev: fst.dev, ino: fst.ino };
    let off = 0;
    while (off < buffer.length) off += writeSync(fd, buffer, off, buffer.length - off);
    hooks.afterWrite?.(path);
    verifyWrittenPath(staging.dirReal, staging.id, path, id, buffer.length, hooks, "staging directory");
    if (!readFdFully(fd, buffer.length).equals(buffer)) throw new Error("staged bytes differ from the verified image.");
    return { path, fd, id };
  } catch (err) {
    try {
      neutraliseAndThrow(fd, path, err, hooks);
    } finally {
      closeSync(fd);
    }
  }
}

// ─── hand-off into output_dir ────────────────────────────────────────────────

/**
 * Prove the handed-off `dest` is our staged image, directly inside output_dir:
 *   1. open the path and check the FD: regular file, the staged file's dev+ino,
 *      exactly `expected.length` bytes, and bytes read through the fd equal to
 *      `expected`;
 *   2. ALL resolution: realpath(dest) a direct child of `outReal`, and
 *      realpath(outReal) equal to `outReal`;
 *   3. LAST: lstat(dest) a non-link with the fd's dev+ino, then output_dir's
 *      identity.
 */
export function verifyHandedOff(
  outReal: string,
  outId: FsIdentity,
  dest: string,
  expected: Buffer,
  stagedId: FsIdentity,
  hooks: WriteHooks = {},
): string {
  const fd = openSync(dest, OPEN_READ_FLAGS);
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) throw new Error(`${dest} is not a regular file after the hand-off.`);
    if (!sameIdentity(st, stagedId)) throw new Error(`${dest} is not the staged file after the hand-off (replaced).`);
    if (st.size !== BigInt(expected.length)) throw new Error(`${dest} has ${st.size} bytes; ${expected.length} were handed off.`);
    if (!readFdFully(fd, expected.length).equals(expected)) throw new Error(`${dest} does not hold the handed-off bytes.`);
    hooks.duringVerify?.(dest);
    const real = realpathSync.native(dest);
    if (!isDirectChildReal(outReal, real)) throw new Error(`handed-off file resolves to ${real}, outside output_dir ${outReal}.`);
    if (!samePath(realpathSync.native(outReal), outReal)) throw new Error(`output_dir ${outReal} no longer resolves to itself.`);
    hooks.afterResolve?.(dest);
    const lst = lstatSync(dest, { bigint: true, throwIfNoEntry: false });
    if (!lst || lst.isSymbolicLink() || !lst.isFile() || !sameIdentity(lst, st)) {
      throw new Error(`${dest} is no longer the file that was handed off (replaced or linked); refusing to report it.`);
    }
    assertOutputDirIdentity(outReal, outId);
    return real;
  } finally {
    closeSync(fd);
  }
}

/**
 * Write `buffer` for `name` into output_dir WITHOUT writing content through
 * any path inside output_dir:
 *   1. `stageImage`: written and verified inside the private staging dir;
 *   2. ONE exclusive hand-off per candidate name: a HARD LINK of the staged
 *      file. `link` never follows or replaces an existing entry — file,
 *      symlink, or dangling symlink — so an occupied name is skipped and the
 *      next is tried, up to `maxCollisions` alternatives, then the call throws;
 *   3. `verifyHandedOff` proves the result before the path is reported.
 *
 * FAIL CLOSED: there is NO copy fallback. When a hard link is impossible
 * (staging and output_dir on different volumes, or a filesystem without hard
 * links) the image is refused: every copy primitive available to Node can
 * follow a link at the destination name (on Windows an exclusive create/copy
 * follows a dangling symlink), which a hard link cannot.
 *
 * Node has no openat, so an output_dir parent swapped for a link in the
 * instant before the link syscall can receive the finished file: that is
 * detected in step 3 and refused, and because the handed-off object IS the
 * staged inode it is truncated through our fd. Nothing is ever deleted by
 * pathname.
 */
export function writeImageSafely(
  outReal: string,
  outId: FsIdentity,
  staging: StagingDir,
  name: string,
  buffer: Buffer,
  maxCollisions: number = MAX_OUTPUT_NAME_COLLISIONS,
  hooks: WriteHooks = {},
): string {
  const staged = stageImage(staging, name, buffer, hooks);
  try {
    const safe = safeOutputName(name);
    const ext = extname(safe);
    const stem = basename(safe, ext);
    for (let attempt = 0; attempt <= maxCollisions; attempt++) {
      const candidate = attempt === 0 ? safe : `${stem}-${attempt}${ext}`;
      assertStagingIntact(staging);
      assertOutputDirIntact(outReal, outId);
      const dest = join(outReal, candidate);
      hooks.beforeHandOff?.(dest);
      try {
        if (hooks.linkError) throw Object.assign(new Error(`forced ${hooks.linkError}`), { code: hooks.linkError });
        linkSync(staged.path, dest);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (code === "EEXIST") continue;
        throw new Error(
          `hand-off refused: a hard link into output_dir failed (${code || (err as Error).message}); there is deliberately no copy ` +
            "fallback, because a copy can follow a link at the destination name. output_dir must be on the same filesystem as the " +
            "daemon's staging directory (PP_HOME) and that filesystem must support hard links. Nothing was written into output_dir.",
        );
      }
      hooks.afterHandOff?.(dest);
      try {
        return verifyHandedOff(outReal, outId, dest, buffer, staged.id, hooks);
      } catch (err) {
        neutraliseAndThrow(staged.fd, dest, err, hooks);
      }
    }
    throw new Error(`output name collision cap reached: ${safe} and ${maxCollisions} alternatives already exist.`);
  } finally {
    closeSync(staged.fd);
  }
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
