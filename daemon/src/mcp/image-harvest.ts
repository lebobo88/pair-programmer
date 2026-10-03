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
  ftruncateSync,
  constants as FS,
} from "node:fs";
import { join, dirname, basename, extname, resolve, relative } from "node:path";
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
  /** Fired after the first fd/path identity check, before realpath. */
  afterFirstCheck?: (path: string) => void;
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
 *   - every chunk's length in bounds and CRC correct; IHDR, PLTE and IEND at
 *     most once; PLTE required before IDAT for palette images and forbidden
 *     for greyscale(+alpha); IDAT chunks consecutive and at least one;
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
  let idatClosed = false;
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
    if (idat.length > 0 && type !== "IDAT") idatClosed = true;
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
      if (idatClosed) return { ok: false, reason: "IDAT chunks are not consecutive." };
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
      /** Identity of the session dir as resolved; every later open re-checks it. */
      dirId: FsIdentity;
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
        const v = openVerifiedFile(res.dirReal, res.dirId, name, maxBytes);
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
          dirId: res.dirId,
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

/** Test-only seams around the write and its verification. Production never sets them. */
export type WriteHooks = {
  /** Fired immediately before the exclusive create. */
  beforeCreate?: (dest: string) => void;
  afterWrite?: (dest: string) => void;
  /** Fired between the first identity check and the realpath resolution. */
  duringVerify?: (dest: string) => void;
  /** Fired after every realpath resolution, before the final identity checks. */
  afterResolve?: (dest: string) => void;
  /** Fired after a failed verification, before the fd-bound neutralisation. */
  beforeNeutralise?: (dest: string) => void;
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
 * Prove `dest` denotes the file created through the fd, inside `outReal`:
 *   1. lstat: non-link regular file with the fd's dev+ino and `size` bytes;
 *   2. ALL resolution: realpath(dest) must be a direct child of `outReal`, and
 *      realpath(outReal) must be `outReal` itself;
 *   3. LAST, no further resolution: the file identity/size check again, then
 *      output_dir's identity.
 * Returns the file's realpath; throws otherwise.
 */
export function verifyWrittenPath(
  outReal: string,
  outId: FsIdentity,
  dest: string,
  fileId: FsIdentity,
  size: number,
  hooks: WriteHooks = {},
): string {
  assertIsWrittenFile(dest, fileId, size);
  hooks.duringVerify?.(dest);
  const real = realpathSync.native(dest);
  if (!isDirectChildReal(outReal, real)) {
    throw new Error(`written file resolves to ${real}, outside output_dir ${outReal}.`);
  }
  if (!samePath(realpathSync.native(outReal), outReal)) {
    throw new Error(`output_dir ${outReal} no longer resolves to itself; refusing to report the write.`);
  }
  hooks.afterResolve?.(dest);
  assertIsWrittenFile(dest, fileId, size);
  assertOutputDirIdentity(outReal, outId);
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
 * Write `buffer` into `outReal` under a sanitized `name`.
 *
 *   1. output_dir's identity is checked, then the file is created EMPTY with
 *      exclusive create (`wx`: never follows or overwrites an existing entry);
 *   2. before a single byte is written, `verifyWrittenPath` must prove the
 *      empty file is ours (fd dev+ino) and directly inside output_dir;
 *   3. only then are the bytes written through the fd, and `verifyWrittenPath`
 *      runs again before the path is reported.
 *
 * Node has no handle-relative (openat) create, so a parent directory swapped
 * for a link in the instant between step 1's check and the create syscall
 * cannot be PREVENTED from receiving the empty file — but it is detected in
 * step 2 and never receives any content. On collision `<stem>-1.png` …
 * `<stem>-<maxCollisions>.png` are tried, then the call throws.
 *
 * On any failed verification NOTHING is deleted by pathname — a path-based
 * unlink cannot be bound to the object we created and could remove a file
 * someone else put there. Our own bytes (if any were written) are truncated
 * through the still-open fd instead; an empty file may remain.
 */
export function writeImageSafely(
  outReal: string,
  outId: FsIdentity,
  name: string,
  buffer: Buffer,
  maxCollisions: number = MAX_OUTPUT_NAME_COLLISIONS,
  hooks: WriteHooks = {},
): string {
  const safe = safeOutputName(name);
  const ext = extname(safe);
  const stem = basename(safe, ext);
  for (let attempt = 0; attempt <= maxCollisions; attempt++) {
    const candidate = attempt === 0 ? safe : `${stem}-${attempt}${ext}`;
    assertOutputDirIntact(outReal, outId);
    const dest = join(outReal, candidate);
    hooks.beforeCreate?.(dest);
    let fd: number;
    try {
      fd = openSync(dest, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    try {
      const fst = fstatSync(fd, { bigint: true });
      const fileId = { dev: fst.dev, ino: fst.ino };
      verifyWrittenPath(outReal, outId, dest, fileId, 0);
      let off = 0;
      while (off < buffer.length) off += writeSync(fd, buffer, off, buffer.length - off);
      hooks.afterWrite?.(dest);
      return verifyWrittenPath(outReal, outId, dest, fileId, buffer.length, hooks);
    } catch (err) {
      hooks.beforeNeutralise?.(dest);
      try { ftruncateSync(fd, 0); } catch { /* the failure is reported regardless */ }
      throw new Error(`${(err as Error).message} (any bytes we wrote were truncated through the fd; an empty file may remain.)`);
    } finally {
      closeSync(fd);
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
