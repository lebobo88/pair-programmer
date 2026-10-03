/**
 * Hermetic tests for `generate_image` on both vendor wrappers.
 *
 * ANTI-STALL TEST RULE: imports only from dist/ and pngjs; no test spawns a
 * real CLI and none touches the real ~/.codex, ~/.pair-programmer or state.db:
 *   - PP_HOME points at a temp directory BEFORE any dist import (the
 *     fresh-session test drives the real session table there);
 *   - `_imagesRoot` replaces ~/.codex/generated_images with a temp fixture;
 *   - `_invoke` replaces the whole codex turn, and `_runCli` replaces only the
 *     CLI runner so the REAL `codexGenerate` is exercised where wiring matters;
 *   - `_fileHooks` fire around the verified open so a path swap can be staged
 *     at an exact point (production never sets them).
 *
 * Every security check is a named export of dist/mcp/image-harvest.js (or
 * codex-server.js / cli-runner.js). The end-to-end tests and the direct
 * falsification fixtures call the SAME function, so a red fixture is evidence
 * about the check, not about node:assert. The mutation log at the bottom
 * records, per guard, the break that was applied and the test that went red.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  statSync,
  realpathSync,
  openSync,
  closeSync,
} from "node:fs";
import zlib from "node:zlib";
import { PNG } from "pngjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

// Isolate the ledger BEFORE any dist import reads paths.ts.
const SUITE_HOME = mkdtempSync(join(tmpdir(), "pp-genimg-home-"));
process.env.PP_HOME = SUITE_HOME;
delete process.env.PP_DB_PATH;

const tmpDirs = [SUITE_HOME];
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
after(async () => {
  // Release the temp ledger's handle first, or Windows refuses to delete state.db.
  const { closeDb } = await importDist("db/database.js");
  closeDb();
  for (const d of tmpDirs.reverse()) rmSync(d, { recursive: true, force: true });
});

const real = (p) => realpathSync.native(p);

// ─── PNG fixtures ────────────────────────────────────────────────────────────

/** Build a solid-color PNG buffer of (width x height). */
function makeSolidPng(width, height, [r, g, b, a] = [255, 0, 0, 255]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = a;
  }
  return PNG.sync.write(png);
}

/** Build a large, high-entropy PNG buffer that resists PNG compression. */
function makeNoisyPng(width, height) {
  const png = new PNG({ width, height });
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % 256;
  };
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rand();
    png.data[i * 4 + 1] = rand();
    png.data[i * 4 + 2] = rand();
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** Independent CRC32 for hand-assembling fixtures (deliberately not the module's). */
function crc32(buf) {
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = pngChunk("IEND", Buffer.alloc(0));

/** A real, valid 8-bit GRAYSCALE PNG (pngjs only writes RGBA). */
function makeGrayscalePng(width, height, value = 128) {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 0;
  const raw = Buffer.alloc(height * (1 + width));
  for (let y = 0; y < height; y++) raw.fill(value, y * (1 + width) + 1, (y + 1) * (1 + width));
  return Buffer.concat([SIGNATURE, pngChunk("IHDR", ihdrData), pngChunk("IDAT", zlib.deflateSync(raw)), IEND]);
}

/** Signature + IHDR only: exactly the 24-byte header the old fast path accepted. */
function make24ByteHeaderPng() {
  const ihdr = pngChunk("IHDR", makeGrayscalePng(4, 4).subarray(16, 29));
  return Buffer.concat([SIGNATURE, ihdr]).subarray(0, 24);
}

/** A valid PNG with its final IEND chunk cut off. */
function makeTruncatedPng() {
  const full = makeSolidPng(8, 8);
  return full.subarray(0, full.length - IEND.length);
}

/** A complete-looking PNG (ends in IEND) whose IDAT CRC is wrong. */
function makeBadCrcPng() {
  const buf = Buffer.from(makeSolidPng(8, 8));
  // IDAT is the chunk after IHDR (8 sig + 25 IHDR); flip a byte of its CRC.
  const idatLen = buf.readUInt32BE(33);
  buf[33 + 8 + idatLen] ^= 0xff;
  return buf;
}

// ─── harness ─────────────────────────────────────────────────────────────────

const baseCodexResult = {
  text: "",
  tokens_in: 10,
  tokens_out: 20,
  cost_usd: 0.001,
  model: "test-model",
  wall_ms: 5,
  exit_code: 0,
};

let sessionCounter = 0;
function newSessionId() {
  sessionCounter += 1;
  return `abcd${String(sessionCounter).padStart(4, "0")}-0000-4000-8000-000000000000`;
}

/**
 * Run codexGenerateImage against temp roots. `write(sessionDir)` runs INSIDE
 * the fake codex turn — writing before the call would make a file
 * indistinguishable from stale carry-over.
 */
async function runHarvest({ sessionId = newSessionId(), write, args = {}, opts = {}, codexResult = {} } = {}) {
  const { codexGenerateImage } = await importDist("mcp/codex-server.js");
  const imagesRoot = opts._imagesRoot ?? tmp("pp-img-root-");
  const outputDir = args.output_dir ?? tmp("pp-img-out-");
  const sessionDir = join(imagesRoot, sessionId);
  let invoked = false;
  const result = await codexGenerateImage(
    { prompt: "draw a circle", cwd: "/some/worktree", output_dir: outputDir, ...args },
    {
      _invoke: async () => {
        invoked = true;
        if (write) await write(sessionDir);
        return { ...baseCodexResult, session_id: sessionId, ...codexResult };
      },
      _imagesRoot: imagesRoot,
      ...opts,
    },
  );
  return { result, imagesRoot, outputDir, sessionDir, sessionId, invoked };
}

function writePngs(files) {
  return (sessionDir) => {
    mkdirSync(sessionDir, { recursive: true });
    for (const [name, buf] of Object.entries(files)) writeFileSync(join(sessionDir, name), buf);
  };
}

// ─── basic harvest contract ──────────────────────────────────────────────────

describe("pp_codex.generate_image: harvest contract", () => {
  test("successful harvest from the session directory", async () => {
    const { result, outputDir, sessionId } = await runHarvest({ write: writePngs({ "exec-call-1.png": makeSolidPng(10, 10) }) });
    assert.equal(result.status, "ok");
    assert.equal(result.session_id, sessionId);
    assert.equal(result.images.length, 1);
    assert.equal(result.over_budget.length, 0);
    assert.deepEqual(result.failures, []);
    const img = result.images[0];
    assert.equal(img.generator, "codex");
    assert.equal(img.model, "test-model");
    assert.equal(img.prompt, "draw a circle");
    assert.equal(dirname(img.path), real(outputDir), "harvested file lands directly in the caller's output_dir");
    assert.equal(readFileSync(img.path).length, img.bytes, "reported byte size matches the file actually written");
    assert.equal(img.width, 10);
    assert.equal(img.height, 10);
  });

  test("a missing session id returns a structured no_session_id failure, never a guessed directory", async () => {
    const { result } = await runHarvest({ codexResult: { session_id: undefined } });
    assert.equal(result.status, "no_session_id");
    assert.match(result.reason, /session_id/i);
  });

  test("a traversal-shaped session_id is rejected instead of used as a path segment", async () => {
    const imagesRoot = tmp("pp-img-root-");
    mkdirSync(join(imagesRoot, "other-session"));
    writeFileSync(join(imagesRoot, "other-session", "secret.png"), makeSolidPng(4, 4));
    const { result, outputDir } = await runHarvest({ sessionId: "../other-session", opts: { _imagesRoot: imagesRoot } });
    assert.equal(result.status, "invalid_session_id");
    assert.deepEqual(readdirSync(outputDir), [], "nothing copied out of the sibling directory");
  });

  test("isValidSessionId accepts a UUID and rejects every path-shaped id", async () => {
    const { isValidSessionId } = await importDist("mcp/image-harvest.js");
    assert.equal(isValidSessionId("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"), true);
    const bad = ["../other", "..", ".", "a/b", "a\\b", "C:", "", "x".repeat(65), "abc.png", "/abs"];
    const accepted = bad.filter(isValidSessionId);
    assert.deepEqual(accepted, [], `path-shaped ids accepted: ${JSON.stringify(accepted)}`);
  });

  test("a non-zero CLI result returns a structured cli_failure, never a stale-but-ok result", async () => {
    const { result } = await runHarvest({
      write: writePngs({ "exec-call-1.png": makeSolidPng(4, 4) }),
      codexResult: { exit_code: 1 },
    });
    assert.equal(result.status, "cli_failure");
    assert.equal(result.exit_code, 1);
  });

  test("an empty session directory returns a structured empty_session_dir failure", async () => {
    const { result, sessionId } = await runHarvest({ write: (dir) => mkdirSync(dir, { recursive: true }) });
    assert.equal(result.status, "empty_session_dir");
    assert.equal(result.session_id, sessionId);
    assert.match(result.reason, /no PNG files/);
  });

  test("a file that pre-dates the call (resumed/stale session) is never returned as a new image", async () => {
    const imagesRoot = tmp("pp-img-root-");
    const sessionId = newSessionId();
    const sessionDir = join(imagesRoot, sessionId);
    mkdirSync(sessionDir);
    const stalePath = join(sessionDir, "exec-call-old.png");
    writeFileSync(stalePath, makeSolidPng(4, 4, [1, 2, 3, 255]));
    const anHourAgo = new Date(Date.now() - 3600_000);
    utimesSync(stalePath, anHourAgo, anHourAgo);
    assert.ok(statSync(stalePath).mtimeMs < Date.now() - 60_000, "fixture mtime really is old");
    // The fake turn writes nothing new — it only reports the old session id.
    const { result } = await runHarvest({ sessionId, opts: { _imagesRoot: imagesRoot } });
    assert.equal(result.status, "empty_session_dir");
    assert.match(result.reason, /pre-date|stale/i);
  });

  test("harvests only the reported session's directory, even when a concurrent session directory is newer (mtimes set)", async () => {
    const imagesRoot = tmp("pp-img-root-");
    const trueSessionId = newSessionId();
    const otherDir = join(imagesRoot, newSessionId());
    mkdirSync(otherDir);
    writeFileSync(join(otherDir, "exec-call-other.png"), makeSolidPng(8, 8, [200, 100, 50, 255]));
    const now = new Date();
    utimesSync(otherDir, now, now);
    const trueDir = join(imagesRoot, trueSessionId);
    const { result } = await runHarvest({
      sessionId: trueSessionId,
      opts: { _imagesRoot: imagesRoot },
      write: (dir) => {
        writePngs({ "exec-call-true.png": makeSolidPng(8, 8, [10, 20, 30, 255]) })(dir);
        const older = new Date(Date.now() - 60_000);
        utimesSync(dir, older, older);
      },
    });
    assert.ok(statSync(otherDir).mtimeMs > statSync(trueDir).mtimeMs, "the concurrent (wrong) session directory must be strictly newer");
    assert.equal(result.status, "ok");
    assert.equal(result.session_id, trueSessionId);
    assert.equal(result.images.length, 1);
    assert.match(result.images[0].path, /exec-call-true\.png$/, "must harvest the reported (older) session's file");
  });
});

// ─── fresh session + single attempt through the REAL codexGenerate ───────────

describe("pp_codex.generate_image: fresh, single-attempt codex turn", () => {
  test("never resumes the stored session, never persists its own, and disables the runner retry", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const { getSession, setSession } = await importDist("orchestrator/sub-cli-sessions.js");
    const cwd = tmp("pp-img-cwd-");
    const imagesRoot = tmp("pp-img-root-");
    const outputDir = tmp("pp-img-out-");
    const SEEDED = "5eed5eed-0000-4000-8000-000000000000";
    setSession(cwd, "codex", SEEDED);
    assert.equal(getSession(cwd, "codex")?.session_id, SEEDED, "precondition: a resumable session exists for this cwd");

    const turnSession = newSessionId();
    const captured = [];
    const result = await codexGenerateImage(
      { prompt: "draw a circle", cwd, output_dir: outputDir },
      {
        _imagesRoot: imagesRoot,
        _runCli: async (runOpts) => {
          captured.push(runOpts);
          writePngs({ "exec-call-1.png": makeSolidPng(6, 6) })(join(imagesRoot, turnSession));
          return {
            stdout: `${JSON.stringify({ type: "thread.started", session_id: turnSession })}\n`,
            stderr: "",
            exit_code: 0,
            wall_ms: 1,
            attempts: [{ exit_code: 0, stderr_tail: "", wall_ms: 1 }],
          };
        },
      },
    );
    assert.equal(captured.length, 1, "the real codexGenerate reached the runner exactly once");
    assert.ok(!captured[0].cliArgs.includes("--resume"), `argv must not resume: ${captured[0].cliArgs.join(" ")}`);
    assert.ok(!captured[0].cliArgs.includes(SEEDED), "the seeded session id never reaches argv");
    assert.equal(captured[0].retry_on_transient, false, "the transient retry is disabled for generate_image");
    assert.equal(captured[0].timeout_ms, 5 * 60 * 1000, "omitted timeout_ms becomes the default");
    assert.equal(getSession(cwd, "codex")?.session_id, SEEDED, "the image turn's session id is never persisted for resumption");
    assert.equal(result.status, "ok");
    assert.equal(result.session_id, turnSession);
  });

  test("cliAttemptBudget: one attempt when retry_on_transient is false, otherwise 1 + CRITIQUE_RETRY_ATTEMPTS", async () => {
    const { cliAttemptBudget } = await importDist("mcp/cli-runner.js");
    const { CRITIQUE_RETRY_ATTEMPTS } = await importDist("config.js");
    assert.ok(CRITIQUE_RETRY_ATTEMPTS >= 1, "precondition: the default path does retry, so the opt-out is observable");
    assert.equal(cliAttemptBudget({ retry_on_transient: false }), 1);
    assert.equal(cliAttemptBudget({}), 1 + CRITIQUE_RETRY_ATTEMPTS);
  });

  test("clampImageTimeoutMs clamps (not rejects) above 15 minutes and defaults when omitted", async () => {
    const { clampImageTimeoutMs, GenerateImageSchema, MAX_GENERATE_IMAGE_TIMEOUT_MS } = await importDist("mcp/codex-server.js");
    assert.equal(MAX_GENERATE_IMAGE_TIMEOUT_MS, 15 * 60 * 1000);
    assert.equal(clampImageTimeoutMs(10 * 60 * 60 * 1000), MAX_GENERATE_IMAGE_TIMEOUT_MS);
    assert.equal(clampImageTimeoutMs(1000), 1000);
    assert.equal(clampImageTimeoutMs(undefined), 5 * 60 * 1000);
    const parsed = GenerateImageSchema.safeParse({ prompt: "p", cwd: "c", output_dir: "o", timeout_ms: 10 * 60 * 60 * 1000 });
    assert.equal(parsed.success, true, "an over-long timeout is accepted by the schema and clamped, not rejected");
  });
});

// ─── limits ──────────────────────────────────────────────────────────────────

describe("pp_codex.generate_image: limits", () => {
  test("max_dimension outside [256, 4096] is rejected before any codex turn", async () => {
    const { GenerateImageSchema } = await importDist("mcp/codex-server.js");
    const base = { prompt: "p", cwd: "c", output_dir: "o" };
    assert.equal(GenerateImageSchema.safeParse({ ...base, max_dimension: 256 }).success, true);
    assert.equal(GenerateImageSchema.safeParse({ ...base, max_dimension: 4096 }).success, true);
    for (const bad of [1, 128, 255, 4097, 100000]) {
      assert.equal(GenerateImageSchema.safeParse({ ...base, max_dimension: bad }).success, false, `max_dimension ${bad} must be rejected`);
    }
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    let invoked = false;
    await assert.rejects(
      codexGenerateImage(
        { prompt: "p", cwd: "/w", output_dir: tmp("pp-img-out-"), max_dimension: 128 },
        { _imagesRoot: tmp("pp-img-root-"), _invoke: async () => { invoked = true; return { ...baseCodexResult, session_id: newSessionId() }; } },
      ),
      /max_dimension|256/,
    );
    assert.equal(invoked, false, "no codex turn is spent on an out-of-range max_dimension");
  });

  test("a large image is downscaled under the byte budget", async () => {
    const BUDGET = 300 * 1024;
    const bigPng = makeNoisyPng(1024, 1024);
    assert.ok(bigPng.length > BUDGET, "fixture must start out over budget");
    const { result } = await runHarvest({ write: writePngs({ "exec-call-big.png": bigPng }), args: { byte_budget_bytes: BUDGET } });
    assert.equal(result.status, "ok");
    const img = result.images[0];
    assert.ok(img.bytes <= BUDGET, `downscaled image (${img.bytes}B) must fit the byte budget (${BUDGET}B)`);
    assert.ok(img.width < 1024 && img.height < 1024, "dimensions must have shrunk from the 1024x1024 original");
    assert.ok(Math.max(img.width, img.height) >= 256, "downscale never goes below the 256px floor");
  });

  test("an image that still exceeds the byte budget at the 256px floor is never reported ok", async () => {
    const IMPOSSIBLE_BUDGET = 200;
    const { result } = await runHarvest({
      write: writePngs({ "exec-call-impossible.png": makeNoisyPng(1024, 1024) }),
      args: { byte_budget_bytes: IMPOSSIBLE_BUDGET },
    });
    assert.equal(result.status, "partial");
    assert.equal(result.images.length, 0, "the over-budget image must not appear in the success list");
    assert.equal(result.over_budget.length, 1);
    assert.ok(result.over_budget[0].bytes > IMPOSSIBLE_BUDGET);
    assert.equal(Math.max(result.over_budget[0].width, result.over_budget[0].height), 256);
  });

  test("downscaleImageToFit starts at min(max_dimension, longest side): a huge max_dimension costs no extra encodes", async () => {
    const { downscaleImageToFit } = await importDist("mcp/image-harvest.js");
    const decoded = PNG.sync.read(makeNoisyPng(1024, 1024));
    const r = downscaleImageToFit(decoded, 4096, 200);
    // 1024 -> 512 -> 256 (floor). Starting from 4096 would add 4096 and 2048 passes.
    assert.equal(r.encodes, 3);
    assert.equal(Math.max(r.width, r.height), 256);
    const fits = downscaleImageToFit(PNG.sync.read(makeSolidPng(300, 200)), 4096, 300 * 1024);
    assert.equal(fits.encodes, 1);
    assert.equal(fits.width, 300, "never upscales past the source size");
  });

  test("an image already small enough is copied byte-for-byte", async () => {
    const smallPng = makeSolidPng(64, 32);
    const { result } = await runHarvest({ write: writePngs({ "exec-call-small.png": smallPng }) });
    assert.equal(result.status, "ok");
    assert.equal(result.images[0].width, 64);
    assert.equal(result.images[0].height, 32);
    assert.deepEqual(readFileSync(result.images[0].path), smallPng);
  });

  test("a non-RGBA PNG that already fits is preserved byte-for-byte", async () => {
    const grayscalePng = makeGrayscalePng(32, 16, 200);
    const { result } = await runHarvest({ write: writePngs({ "exec-call-gray.png": grayscalePng }) });
    assert.equal(result.status, "ok");
    assert.deepEqual(readFileSync(result.images[0].path), grayscalePng, "never decoded/re-encoded to RGBA");
  });

  test("image cap: only the first 20 PNGs are processed; the rest are reported, not opened", async () => {
    const files = {};
    for (let i = 0; i < 25; i++) files[`exec-call-${String(i).padStart(2, "0")}.png`] = makeSolidPng(4, 4);
    const { result } = await runHarvest({ write: writePngs(files) });
    assert.equal(result.images.length, 20);
    const capped = result.failures.filter((f) => /per-call image cap/.test(f.reason));
    assert.equal(capped.length, 5);
    assert.equal(result.status, "partial");
  });

  test("enumeration cap: at most 200 session-directory entries are visited, and truncation is reported", async () => {
    const { result } = await runHarvest({
      write: (dir) => {
        mkdirSync(dir, { recursive: true });
        for (let i = 0; i < 260; i++) writeFileSync(join(dir, `pad-${i}.txt`), "");
        writeFileSync(join(dir, "exec-call-1.png"), makeSolidPng(4, 4));
      },
    });
    assert.equal(result.scanned_entries, 200);
    assert.equal(result.enumeration_truncated, true);
    assert.ok(result.failures.some((f) => f.file === "*" && /enumeration stopped after 200/.test(f.reason)));
    assert.notEqual(result.status, "ok");
  });

  test("size cap: a source PNG over 32MiB is refused from fstat before it is read", async () => {
    const huge = Buffer.concat([makeSolidPng(4, 4).subarray(0, 33), Buffer.alloc(32 * 1024 * 1024 + 16), IEND]);
    const { result } = await runHarvest({
      write: writePngs({ "exec-call-huge.png": huge, "exec-call-ok.png": makeSolidPng(4, 4) }),
    });
    const f = result.failures.find((x) => x.file === "exec-call-huge.png");
    assert.ok(f, `the oversized file must be a per-file failure: ${JSON.stringify(result.failures)}`);
    assert.match(f.reason, /exceeds the per-image size cap/);
    assert.equal(result.images.length, 1);
    assert.equal(result.status, "partial");
  });

  test("collision cap: after 100 alternative names the image fails instead of looping", async () => {
    const outputDir = tmp("pp-img-out-");
    writeFileSync(join(outputDir, "exec-call-1.png"), "taken");
    for (let i = 1; i <= 100; i++) writeFileSync(join(outputDir, `exec-call-1-${i}.png`), "taken");
    const { result } = await runHarvest({ write: writePngs({ "exec-call-1.png": makeSolidPng(4, 4) }), args: { output_dir: outputDir } });
    assert.equal(result.status, "failed");
    assert.match(result.failures[0].reason, /collision cap reached/);
    assert.equal(readdirSync(outputDir).length, 101, "no 102nd file was created");
  });

  test("writeImageSafely: picks the next free name, and throws once maxCollisions is exhausted", async () => {
    const { writeImageSafely } = await importDist("mcp/image-harvest.js");
    const outReal = real(tmp("pp-img-out-"));
    const png = makeSolidPng(2, 2);
    writeFileSync(join(outReal, "a.png"), "taken");
    assert.equal(writeImageSafely(outReal, "a.png", png, 3), join(outReal, "a-1.png"));
    writeFileSync(join(outReal, "a-2.png"), "taken");
    writeFileSync(join(outReal, "a-3.png"), "taken");
    assert.throws(() => writeImageSafely(outReal, "a.png", png, 3), /collision cap reached/);
  });
});

// ─── PNG validation ──────────────────────────────────────────────────────────

describe("pp_codex.generate_image: PNG structure", () => {
  test("validatePngStructure accepts real PNGs and rejects header-only, truncated, bad-CRC and trailing-byte files", async () => {
    const { validatePngStructure } = await importDist("mcp/image-harvest.js");
    for (const [label, buf] of [["rgba", makeSolidPng(5, 3)], ["grayscale", makeGrayscalePng(7, 2)]]) {
      const r = validatePngStructure(buf);
      assert.equal(r.ok, true, `${label} must validate: ${r.reason}`);
    }
    assert.equal(validatePngStructure(makeSolidPng(5, 3)).width, 5);
    const header = make24ByteHeaderPng();
    assert.equal(header.length, 24);
    const cases = {
      "24-byte header": [header, /truncated|runs past/],
      "missing IEND": [makeTruncatedPng(), /IEND/],
      "bad IDAT CRC": [makeBadCrcPng(), /CRC mismatch in IDAT/],
      "trailing bytes": [Buffer.concat([makeSolidPng(2, 2), Buffer.from([0])]), /after IEND/],
      "no signature": [makeSolidPng(2, 2).subarray(1), /signature/],
    };
    for (const [label, [buf, reason]] of Object.entries(cases)) {
      const r = validatePngStructure(buf);
      assert.equal(r.ok, false, `${label} must be rejected`);
      assert.match(r.reason, reason, label);
    }
  });

  test("malformed files are per-file failures: a bad-CRC PNG that would fit as-is is never copied", async () => {
    const { result, outputDir } = await runHarvest({
      write: writePngs({ "exec-call-bad.png": makeBadCrcPng(), "exec-call-good.png": makeSolidPng(4, 4) }),
    });
    assert.equal(result.status, "partial");
    assert.equal(result.images.length, 1);
    assert.match(result.images[0].path, /exec-call-good\.png$/);
    const f = result.failures.find((x) => x.file === "exec-call-bad.png");
    assert.match(f?.reason ?? "", /malformed PNG: CRC mismatch/);
    assert.deepEqual(readdirSync(outputDir), ["exec-call-good.png"]);
  });

  test("a 24-byte header-only PNG and a truncated PNG never settle and are reported, not copied", async () => {
    const { result, outputDir } = await runHarvest({
      write: writePngs({
        "exec-call-header.png": make24ByteHeaderPng(),
        "exec-call-trunc.png": makeTruncatedPng(),
        "exec-call-good.png": makeSolidPng(4, 4),
      }),
    });
    assert.equal(result.status, "partial");
    assert.deepEqual(readdirSync(outputDir), ["exec-call-good.png"]);
    for (const name of ["exec-call-header.png", "exec-call-trunc.png"]) {
      const f = result.failures.find((x) => x.file === name);
      assert.match(f?.reason ?? "", /did not settle.*IEND/, name);
    }
  });

  test("a PNG flushed in two parts after the CLI returns is harvested complete (bounded settle poll)", async () => {
    const full = makeNoisyPng(64, 64);
    const half = Math.floor(full.length / 2);
    const { result } = await runHarvest({
      write: (dir) => {
        mkdirSync(dir, { recursive: true });
        const p = join(dir, "exec-call-delayed.png");
        writeFileSync(p, full.subarray(0, half)); // visible, but incomplete
        setTimeout(() => appendFileSync(p, full.subarray(half)), 400);
      },
    });
    assert.equal(result.status, "ok", JSON.stringify(result.failures));
    assert.deepEqual(readFileSync(result.images[0].path), full, "the complete file, not the first half");
  });

  test("pollForSettledPngs requires two identical observations before accepting a file", async () => {
    const { pollForSettledPngs } = await importDist("mcp/image-harvest.js");
    const imagesRoot = tmp("pp-img-root-");
    const sessionId = newSessionId();
    writePngs({ "a.png": makeSolidPng(4, 4) })(join(imagesRoot, sessionId));
    const start = Date.now();
    const r = await pollForSettledPngs(imagesRoot, sessionId, { intervalMs: 300, timeoutMs: 3000 });
    const elapsed = Date.now() - start;
    assert.equal(r.kind, "ok");
    assert.deepEqual(r.settled.map((s) => s.name), ["a.png"]);
    assert.ok(elapsed >= 250, `a complete file was accepted after ${elapsed}ms — on the first observation`);
  });
});

// ─── physical containment: sources ──────────────────────────────────────────

describe("pp_codex.generate_image: source containment", () => {
  test("a session directory that is a junction/symlink is refused, even when it aliases another session inside the root", async () => {
    const imagesRoot = tmp("pp-img-root-");
    const victim = join(imagesRoot, newSessionId());
    writePngs({ "exec-call-victim.png": makeSolidPng(4, 4) })(victim);
    const outside = tmp("pp-img-outside-");
    writeFileSync(join(outside, "exec-call-outside.png"), makeSolidPng(4, 4));
    for (const target of [victim, outside]) {
      const sessionId = newSessionId();
      symlinkSync(target, join(imagesRoot, sessionId), "junction");
      const { result, outputDir } = await runHarvest({ sessionId, opts: { _imagesRoot: imagesRoot } });
      assert.equal(result.status, "invalid_session_dir", `target ${target}`);
      assert.match(result.reason, /symlink\/junction/);
      assert.deepEqual(readdirSync(outputDir), []);
    }
  });

  test("isDirectChildReal: realpath containment rejects a junction that resolves outside the parent", async () => {
    const { isDirectChildReal } = await importDist("mcp/image-harvest.js");
    const root = real(tmp("pp-img-root-"));
    const outside = real(tmp("pp-img-outside-"));
    mkdirSync(join(root, "inside"));
    symlinkSync(outside, join(root, "link"), "junction");
    assert.equal(isDirectChildReal(root, real(join(root, "inside"))), true);
    assert.equal(isDirectChildReal(root, real(join(root, "link"))), false);
    assert.equal(isDirectChildReal(root, join(root, "inside", "deeper")), false, "a grandchild is not a direct child");
  });

  test("a symlinked .png or a directory named .png is reported and never read", async () => {
    const outside = tmp("pp-img-outside-");
    const outsideFile = join(outside, "secret.png");
    const secret = makeSolidPng(4, 4, [9, 9, 9, 255]);
    writeFileSync(outsideFile, secret);
    const { result, outputDir } = await runHarvest({
      write: (dir) => {
        writePngs({ "exec-call-real.png": makeSolidPng(4, 4) })(dir);
        symlinkSync(outsideFile, join(dir, "exec-call-link.png"), "file");
        mkdirSync(join(dir, "x.png"));
      },
    });
    assert.equal(result.status, "partial");
    assert.deepEqual(readdirSync(outputDir), ["exec-call-real.png"]);
    for (const name of ["exec-call-link.png", "x.png"]) {
      assert.match(result.failures.find((f) => f.file === name)?.reason ?? "", /not a regular file/, name);
    }
  });

  test("a file swapped to a symlink between enumeration and open is refused", async () => {
    const outside = tmp("pp-img-outside-");
    const outsideFile = join(outside, "secret.png");
    const secret = makeSolidPng(4, 4, [9, 9, 9, 255]);
    writeFileSync(outsideFile, secret);
    const { result, outputDir } = await runHarvest({
      write: writePngs({ "exec-call-1.png": makeSolidPng(4, 4) }),
      opts: {
        _fileHooks: {
          beforeOpen: (p) => {
            renameSync(p, `${p}.moved`);
            symlinkSync(outsideFile, p, "file");
          },
        },
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.failures[0].reason, /symlink|open failed \(ELOOP\)/);
    assert.deepEqual(readdirSync(outputDir), [], "the outside file's bytes were never written");
  });

  test("a path replaced after the open is detected by the fd identity check", async () => {
    const replacement = makeSolidPng(4, 4, [0, 255, 0, 255]);
    const { result, outputDir } = await runHarvest({
      write: writePngs({ "exec-call-1.png": makeSolidPng(4, 4) }),
      opts: {
        _fileHooks: {
          afterOpen: (p) => {
            renameSync(p, `${p}.moved`);
            writeFileSync(p, replacement);
          },
        },
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.failures[0].reason, /replaced between open and verification/);
    assert.deepEqual(readdirSync(outputDir), []);
  });

  test("bytes are read from the verified fd: a path swapped after verification does not change what is read", async () => {
    const original = makeSolidPng(4, 4, [255, 0, 0, 255]);
    const replacement = makeSolidPng(4, 4, [0, 255, 0, 255]);
    const { result } = await runHarvest({
      write: writePngs({ "exec-call-1.png": original }),
      opts: {
        _fileHooks: {
          afterVerify: (p) => {
            renameSync(p, `${p}.moved`);
            writeFileSync(p, replacement);
          },
        },
      },
    });
    assert.equal(result.status, "ok");
    const written = readFileSync(result.images[0].path);
    assert.deepEqual(written, original);
    assert.notDeepEqual(written, replacement);
  });
});

// ─── physical containment: output ────────────────────────────────────────────

describe("pp_codex.generate_image: output containment", () => {
  test("an output_dir that is a junction/symlink is refused before any codex turn", async () => {
    const escape = tmp("pp-img-escape-");
    const parent = tmp("pp-img-outparent-");
    const linked = join(parent, "out");
    symlinkSync(escape, linked, "junction");
    for (const outputDir of [linked, join(linked, "sub")]) {
      const { result, invoked } = await runHarvest({ write: writePngs({ "exec-call-1.png": makeSolidPng(4, 4) }), args: { output_dir: outputDir } });
      if (outputDir === linked) {
        assert.equal(result.status, "invalid_output_dir");
        assert.match(result.reason, /symlink\/junction/);
        assert.equal(invoked, false, "no codex turn is spent on a rejected output_dir");
      } else {
        // An existing linked ANCESTOR is the caller's choice; writes go to its real location and are verified there.
        assert.equal(result.status, "ok");
        assert.equal(dirname(result.images[0].path), real(join(escape, "sub")));
      }
    }
    assert.deepEqual(readdirSync(escape), ["sub"], "only the explicitly requested sub path was created");
  });

  test("prepareOutputDir creates missing components and refuses a pre-existing linked output_dir", async () => {
    const { prepareOutputDir } = await importDist("mcp/image-harvest.js");
    const base = tmp("pp-img-outbase-");
    const nested = join(base, "a", "b", "c");
    const ok = prepareOutputDir(nested);
    assert.equal(ok.ok, true);
    assert.equal(ok.outReal, real(nested));
    const escape = tmp("pp-img-escape-");
    symlinkSync(escape, join(base, "link"), "junction");
    const bad = prepareOutputDir(join(base, "link"));
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /symlink\/junction/);
  });

  test("assertOutputDirIntact and writeImageSafely refuse an output_dir swapped to a junction after it was prepared", async () => {
    const { assertOutputDirIntact, writeImageSafely, prepareOutputDir } = await importDist("mcp/image-harvest.js");
    const base = tmp("pp-img-outbase-");
    const escape = tmp("pp-img-escape-");
    const prepared = prepareOutputDir(join(base, "out"));
    assert.equal(prepared.ok, true);
    assert.doesNotThrow(() => assertOutputDirIntact(prepared.outReal));
    rmSync(prepared.outReal, { recursive: true });
    symlinkSync(escape, prepared.outReal, "junction");
    assert.throws(() => assertOutputDirIntact(prepared.outReal), /no longer a plain directory/);
    assert.throws(() => writeImageSafely(prepared.outReal, "x.png", makeSolidPng(2, 2)), /no longer a plain directory/);
    assert.deepEqual(readdirSync(escape), [], "nothing landed in the junction target");
  });

  test("verifyWrittenPath rejects a written file whose realpath parent is not output_dir", async () => {
    const { verifyWrittenPath } = await importDist("mcp/image-harvest.js");
    const outReal = real(tmp("pp-img-out-"));
    const escape = real(tmp("pp-img-escape-"));
    writeFileSync(join(outReal, "fine.png"), "x");
    assert.equal(verifyWrittenPath(outReal, join(outReal, "fine.png")), join(outReal, "fine.png"));
    mkdirSync(join(escape, "d"));
    writeFileSync(join(escape, "d", "x.png"), "x");
    symlinkSync(join(escape, "d"), join(outReal, "via"), "junction");
    assert.throws(() => verifyWrittenPath(outReal, join(outReal, "via", "x.png")), /outside output_dir/);
  });

  test("a pre-existing symlink at the destination name is never followed or overwritten", async () => {
    const outputDir = tmp("pp-img-out-");
    const escape = tmp("pp-img-escape-");
    const canary = join(escape, "canary.txt");
    writeFileSync(canary, "do-not-touch");
    symlinkSync(canary, join(outputDir, "exec-call-1.png"), "file");
    const { result } = await runHarvest({ write: writePngs({ "exec-call-1.png": makeSolidPng(4, 4) }), args: { output_dir: outputDir } });
    assert.equal(result.status, "ok");
    assert.equal(result.images[0].path, join(real(outputDir), "exec-call-1-1.png"));
    assert.equal(readFileSync(canary, "utf8"), "do-not-touch");
  });
});

// ─── round-2 findings: swap races and image-data validation ──────────────────

/** Assemble a PNG from parts: IHDR fields, an optional PLTE, and IDAT data (raw scanlines or an explicit zlib stream). */
function assemblePng({ width, height, bitDepth = 8, colorType = 0, interlace = 0, raw, idat, plte, splitIdatWith }) {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = bitDepth;
  ihdrData[9] = colorType;
  ihdrData[12] = interlace;
  const stream = idat ?? zlib.deflateSync(raw);
  const chunks = [SIGNATURE, pngChunk("IHDR", ihdrData)];
  if (plte) chunks.push(pngChunk("PLTE", plte));
  if (splitIdatWith) {
    const half = Math.floor(stream.length / 2);
    chunks.push(pngChunk("IDAT", stream.subarray(0, half)), pngChunk(splitIdatWith, Buffer.from("x")), pngChunk("IDAT", stream.subarray(half)));
  } else {
    chunks.push(pngChunk("IDAT", stream));
  }
  chunks.push(IEND);
  return Buffer.concat(chunks);
}

/**
 * Raw (inflated) scanlines for an 8-bit greyscale image, filter type 0. For
 * interlace=1 the Adam7 pass table is written out independently here — NOT
 * taken from the module — so the fixture does not share the code under test.
 */
function greyScanlines(width, height, interlace = 0, filter = 0) {
  const passes = interlace
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]];
  const parts = [];
  for (const [x0, y0, dx, dy] of passes) {
    const w = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const h = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    if (!w || !h) continue;
    for (let r = 0; r < h; r++) parts.push(Buffer.from([filter]), Buffer.alloc(w, 90));
  }
  return Buffer.concat(parts);
}

describe("pp_codex.generate_image: round-2 findings", () => {
  test("fixture oracle: pngjs decodes the hand-assembled interlaced and plain PNGs", () => {
    for (const interlace of [0, 1]) {
      const buf = assemblePng({ width: 13, height: 11, interlace, raw: greyScanlines(13, 11, interlace) });
      const decoded = PNG.sync.read(buf);
      assert.equal(decoded.width, 13, `interlace=${interlace}`);
    }
  });

  test("validatePngStructure validates image data: undecodable IDAT, bombs, wrong length, bad filters, trailing zlib bytes, chunk rules and the pixel cap", async () => {
    const { validatePngStructure } = await importDist("mcp/image-harvest.js");
    for (const interlace of [0, 1]) {
      const good = assemblePng({ width: 13, height: 11, interlace, raw: greyScanlines(13, 11, interlace) });
      const r = validatePngStructure(good);
      assert.equal(r.ok, true, `valid interlace=${interlace}: ${r.reason}`);
      assert.equal(r.interlaced, interlace === 1);
    }
    const cases = {
      "CRC-correct garbage IDAT": [assemblePng({ width: 4, height: 4, idat: Buffer.from([1, 2, 3, 4]) }), /does not inflate/],
      "interlaced decompression bomb": [assemblePng({ width: 4, height: 4, interlace: 1, raw: Buffer.alloc(8 * 1024 * 1024) }), /inflates past/],
      "plain decompression bomb": [assemblePng({ width: 4, height: 4, raw: Buffer.alloc(8 * 1024 * 1024) }), /inflates past/],
      "short image data": [assemblePng({ width: 4, height: 4, raw: Buffer.alloc(10) }), /inflates to 10 bytes; IHDR implies exactly 20/],
      "bad filter byte": [assemblePng({ width: 4, height: 4, raw: greyScanlines(4, 4, 0, 5) }), /invalid scanline filter type 5/],
      "trailing zlib bytes": [assemblePng({ width: 4, height: 4, idat: Buffer.concat([zlib.deflateSync(greyScanlines(4, 4)), Buffer.from([7, 7])]) }), /trailing bytes after the zlib stream/],
      "PLTE in greyscale": [assemblePng({ width: 4, height: 4, raw: greyScanlines(4, 4), plte: Buffer.alloc(3) }), /PLTE in a greyscale/],
      "non-consecutive IDAT": [assemblePng({ width: 4, height: 4, raw: greyScanlines(4, 4), splitIdatWith: "tEXt" }), /not consecutive/],
      "pixel cap before inflation": [assemblePng({ width: 5000, height: 5000, idat: Buffer.from([1]) }), /pixel budget/],
    };
    for (const [label, [buf, reason]] of Object.entries(cases)) {
      const r = validatePngStructure(buf);
      assert.equal(r.ok, false, `${label} must be rejected`);
      assert.match(r.reason, reason, label);
    }
  });

  test("a CRC-correct undecodable PNG and an interlaced decompression bomb that 'fit as-is' are never copied", async () => {
    const bomb = assemblePng({ width: 4, height: 4, interlace: 1, raw: Buffer.alloc(8 * 1024 * 1024) });
    assert.ok(bomb.length < 300 * 1024, "the bomb is small enough to take the verbatim-copy path");
    const { result, outputDir } = await runHarvest({
      write: writePngs({
        "exec-call-bomb.png": bomb,
        "exec-call-garbage.png": assemblePng({ width: 4, height: 4, idat: Buffer.from([1, 2, 3, 4]) }),
        "exec-call-good.png": makeSolidPng(4, 4),
      }),
    });
    assert.equal(result.status, "partial");
    assert.deepEqual(readdirSync(outputDir), ["exec-call-good.png"]);
    assert.match(result.failures.find((f) => f.file === "exec-call-bomb.png")?.reason ?? "", /inflates past/);
    assert.match(result.failures.find((f) => f.file === "exec-call-garbage.png")?.reason ?? "", /does not inflate/);
  });

  test("resolveSessionDir: a plain session dir swapped for a junction to another session between lstat and realpath is refused", async () => {
    const { resolveSessionDir } = await importDist("mcp/image-harvest.js");
    const root = tmp("pp-img-root-");
    const victim = join(root, newSessionId());
    writePngs({ "secret.png": makeSolidPng(4, 4) })(victim);
    const sessionId = newSessionId();
    mkdirSync(join(root, sessionId));
    assert.equal(resolveSessionDir(root, sessionId).kind, "ok", "precondition: the unswapped dir resolves");
    const r = resolveSessionDir(root, sessionId, {
      afterLstat: (candidate) => {
        renameSync(candidate, `${candidate}-moved`);
        symlinkSync(victim, candidate, "junction");
      },
    });
    assert.equal(r.kind, "rejected");
    assert.match(r.reason, /replaced between lstat and realpath/);
  });

  test("a session dir replaced after resolution is refused at file open, even by a same-named plain directory", async () => {
    const { result, outputDir } = await runHarvest({
      write: writePngs({ "exec-call-1.png": makeSolidPng(4, 4) }),
      opts: {
        _fileHooks: {
          beforeOpen: (p) => {
            const dir = dirname(p);
            renameSync(dir, `${dir}-moved`);
            writePngs({ "exec-call-1.png": makeSolidPng(4, 4, [0, 0, 255, 255]) })(dir);
          },
        },
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.failures[0].reason, /session directory .* was replaced/);
    assert.deepEqual(readdirSync(outputDir), []);
  });

  test("prepareOutputDir: an intermediate created component swapped for a junction stops the walk before anything is created through it", async () => {
    const { prepareOutputDir } = await importDist("mcp/image-harvest.js");
    const base = tmp("pp-img-outbase-");
    const escape = tmp("pp-img-escape-");
    const r = prepareOutputDir(join(base, "a", "b", "c"), {
      afterCreate: (dir) => {
        if (dir !== join(base, "a")) return;
        rmSync(dir, { recursive: true });
        symlinkSync(escape, dir, "junction");
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /was replaced/);
    assert.deepEqual(readdirSync(escape), [], "no directory was created inside the junction target");
  });

  test("prepareOutputDir: a created component replaced before the final check is refused by identity", async () => {
    const { prepareOutputDir } = await importDist("mcp/image-harvest.js");
    const base = tmp("pp-img-outbase-");
    const b = join(base, "a", "b");
    const r = prepareOutputDir(b, {
      beforeFinalCheck: () => {
        renameSync(b, `${b}-moved`);
        mkdirSync(b); // same path, plain directory, different identity
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /created output component .* was replaced/);
  });

  test("prepareOutputDir: a linked existing ancestor retargeted before the final check is refused by realpath", async () => {
    const { prepareOutputDir } = await importDist("mcp/image-harvest.js");
    const base = tmp("pp-img-outbase-");
    const t1 = tmp("pp-img-t1-");
    const t2 = tmp("pp-img-t2-");
    mkdirSync(join(t1, "x"));
    mkdirSync(join(t2, "x"));
    const link = join(base, "link");
    symlinkSync(t1, link, "junction"); // an existing linked ANCESTOR is allowed
    const ok = prepareOutputDir(join(link, "x"));
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(ok.outReal, real(join(t1, "x")));
    const r = prepareOutputDir(join(link, "x"), {
      beforeFinalCheck: () => {
        rmSync(link);
        symlinkSync(t2, link, "junction");
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /resolves to .*, not /);
  });
});

describe("pp_agy.generate_image", () => {
  test("returns a structured unsupported result naming the reason, per the real headless probe", async () => {
    const { agyGenerateImage } = await importDist("mcp/antigravity-server.js");
    const result = await agyGenerateImage({
      prompt: "draw a circle",
      cwd: "/some/worktree",
      output_dir: "/tmp/unused",
      max_dimension: 768,
      byte_budget_bytes: 300 * 1024,
    });
    assert.equal(result.status, "unsupported");
    assert.match(result.reason, /scratch/i);
    assert.match(result.reason, /session/i);
  });
});

/**
 * ─── Mutation-proof log (2026-10-03, Windows 11 / Node 22.20) ───────────────
 *
 * Each guard was broken with ONE exact replacement (uncommitted), `npx tsc`,
 * then `node --test --test-timeout=60000 test/generate-image.unit.mjs`; the
 * source was restored and verified byte-identical by sha256 after every run.
 * Guard broken -> test(s) that went red:
 *   session-id pattern (return true)            -> traversal-shaped session_id; isValidSessionId
 *   session-dir lstat symlink refusal           -> session directory that is a junction/symlink (alias case)
 *   isDirectChildReal (return true)             -> isDirectChildReal; verifyWrittenPath
 *   fd dev/ino identity check                   -> path replaced after the open
 *   post-open lstat symlink check               -> file swapped to a symlink between enumeration and open
 *   read via readFileSync(path) instead of fd   -> bytes are read from the verified fd
 *   fstat size cap                              -> size cap
 *   structure validation (old 24-byte accept)   -> malformed files are per-file failures (bad CRC)
 *   IEND required by validator                  -> validatePngStructure accepts/rejects
 *   settle: IEND trailer required               -> 24-byte/truncated never settle; PNG flushed in two parts
 *   settle: two identical observations          -> pollForSettledPngs requires two identical observations
 *   stale mtime refusal                         -> a file that pre-dates the call
 *   fresh_session: false                        -> never resumes the stored session ...
 *   retry_on_transient not passed               -> never resumes the stored session ... (retry assertion)
 *   cliAttemptBudget opt-out removed            -> cliAttemptBudget
 *   timeout clamp removed                       -> clampImageTimeoutMs
 *   max_dimension min(1)                        -> max_dimension outside [256, 4096]
 *   enumeration cap removed                     -> enumeration cap
 *   image cap removed                           -> image cap
 *   collision cap +1000                         -> collision cap; writeImageSafely
 *   downscale starts at max_dimension           -> downscaleImageToFit starts at min(...)
 *   downscale byte-budget check removed         -> large image downscaled; floor never ok; encodes
 *   output_dir symlink refusal                  -> output_dir junction refused; prepareOutputDir
 *   assertOutputDirIntact lstat check           -> assertOutputDirIntact and writeImageSafely
 *   verifyWrittenPath check                     -> verifyWrittenPath
 *   floor-over-budget reported as image         -> floor never reported ok
 *   fits-as-is verbatim copy disabled           -> non-RGBA PNG preserved byte-for-byte
 *   exit_code check removed                     -> non-zero CLI result returns cli_failure
 *   newest-mtime scan instead of session id     -> concurrent session newer (mtimes set); junction alias
 *
 * Round 2 (every guard above re-run against the round-2 code, plus):
 *   session dir lstat/realpath identity         -> resolveSessionDir: swapped between lstat and realpath
 *   session dir identity re-checked at open     -> session dir replaced after resolution
 *   pre-mkdir parent identity                   -> intermediate created component swapped for a junction
 *   final created-component identity           -> created component replaced before the final check
 *   realpath == pinned ancestor + created names -> linked existing ancestor retargeted
 *   inflate maxOutputLength removed             -> validatePngStructure image data; bomb never copied
 *   exact inflated length                       -> validatePngStructure image data (short data)
 *   scanline filter bytes                       -> validatePngStructure image data (bad filter)
 *   trailing zlib bytes                         -> validatePngStructure image data (trailing bytes)
 *   image data not validated at all             -> validatePngStructure image data; bomb/garbage never copied
 *   PLTE in greyscale / non-consecutive IDAT /
 *   pixel cap before inflation                  -> validatePngStructure image data
 *   output_dir link refusal (early + final)     -> output_dir junction refused; prepareOutputDir
 */
