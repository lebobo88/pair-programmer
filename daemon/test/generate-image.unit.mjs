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
import { basename, dirname, join } from "node:path";
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
  lutimesSync,
  statSync,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  writeSync,
  linkSync,
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

// A private staging directory for direct writeImageSafely calls (PP_HOME is
// already isolated above, so this import cannot reach the real ledger).
const { createStagingDir } = await importDist("mcp/image-harvest.js");
function newStaging() {
  const r = createStagingDir(join(tmp("pp-img-stage-"), "image-staging"));
  assert.ok(r.ok, r.reason);
  return r.staging;
}

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
    const { writeImageSafely, prepareOutputDir } = await importDist("mcp/image-harvest.js");
    const { outReal, outId } = prepareOutputDir(tmp("pp-img-out-"));
    const png = makeSolidPng(2, 2);
    writeFileSync(join(outReal, "a.png"), "taken");
    assert.equal(writeImageSafely(outReal, outId, newStaging(), "a.png", png, 3), join(outReal, "a-1.png"));
    writeFileSync(join(outReal, "a-2.png"), "taken");
    writeFileSync(join(outReal, "a-3.png"), "taken");
    assert.throws(() => writeImageSafely(outReal, outId, newStaging(), "a.png", png, 3), /collision cap reached/);
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
    assert.doesNotThrow(() => assertOutputDirIntact(prepared.outReal, prepared.outId));
    rmSync(prepared.outReal, { recursive: true });
    symlinkSync(escape, prepared.outReal, "junction");
    assert.throws(() => assertOutputDirIntact(prepared.outReal, prepared.outId), /no longer resolves to itself|no longer a plain directory/);
    assert.throws(() => writeImageSafely(prepared.outReal, prepared.outId, newStaging(), "x.png", makeSolidPng(2, 2)), /no longer resolves to itself|no longer a plain directory/);
    assert.deepEqual(readdirSync(escape), [], "nothing landed in the junction target");
  });

  test("verifyWrittenPath rejects a written file whose realpath parent is not output_dir", async () => {
    const { verifyWrittenPath, prepareOutputDir } = await importDist("mcp/image-harvest.js");
    const { outReal, outId } = prepareOutputDir(tmp("pp-img-out-"));
    const escape = real(tmp("pp-img-escape-"));
    const idOf = (p) => { const s = statSync(p, { bigint: true }); return { dev: s.dev, ino: s.ino }; };
    writeFileSync(join(outReal, "fine.png"), "x");
    assert.equal(verifyWrittenPath(outReal, outId, join(outReal, "fine.png"), idOf(join(outReal, "fine.png")), 1), join(outReal, "fine.png"));
    mkdirSync(join(escape, "d"));
    writeFileSync(join(escape, "d", "x.png"), "x");
    symlinkSync(join(escape, "d"), join(outReal, "via"), "junction");
    const viaFile = join(outReal, "via", "x.png");
    assert.throws(() => verifyWrittenPath(outReal, outId, viaFile, idOf(viaFile), 1), /outside output_dir/);
  });

  test("output_dir replaced by a different PLAIN directory after preparation is refused (direct and via an ancestor)", async () => {
    const { assertOutputDirIntact, writeImageSafely, prepareOutputDir } = await importDist("mcp/image-harvest.js");
    const base = tmp("pp-img-outbase-");
    const direct = prepareOutputDir(join(base, "out"));
    renameSync(direct.outReal, `${direct.outReal}-moved`);
    mkdirSync(direct.outReal);
    assert.throws(() => assertOutputDirIntact(direct.outReal, direct.outId), /replaced by a different directory/);
    assert.throws(() => writeImageSafely(direct.outReal, direct.outId, newStaging(), "x.png", makeSolidPng(2, 2)), /replaced by a different directory/);
    assert.deepEqual(readdirSync(direct.outReal), []);

    const viaAncestor = prepareOutputDir(join(base, "p", "out"));
    const parent = dirname(viaAncestor.outReal);
    renameSync(parent, `${parent}-moved`);
    mkdirSync(viaAncestor.outReal, { recursive: true });
    assert.throws(() => assertOutputDirIntact(viaAncestor.outReal, viaAncestor.outId), /replaced by a different directory/);
  });

  test("end to end: an output_dir replaced during the codex turn receives nothing", async () => {
    const outputDir = tmp("pp-img-out-");
    const { result } = await runHarvest({
      args: { output_dir: outputDir },
      write: (dir) => {
        writePngs({ "exec-call-1.png": makeSolidPng(4, 4) })(dir);
        renameSync(outputDir, `${outputDir}-moved`);
        tmpDirs.push(`${outputDir}-moved`);
        mkdirSync(outputDir);
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.failures[0].reason, /replaced by a different directory/);
    assert.deepEqual(readdirSync(outputDir), []);
  });

  test("writeImageSafely: a handed-off file replaced (by another file or a link to a sibling) is refused; the replacement survives and only our own object is truncated", async () => {
    const { writeImageSafely, prepareOutputDir } = await importDist("mcp/image-harvest.js");
    for (const kind of ["file", "link"]) {
      const { outReal, outId } = prepareOutputDir(tmp("pp-img-out-"));
      const sibling = join(outReal, "sibling.png");
      writeFileSync(sibling, makeSolidPng(3, 3));
      assert.throws(
        () =>
          writeImageSafely(outReal, outId, newStaging(), "x.png", makeSolidPng(2, 2), 0, {
            afterHandOff: (dest) => {
              renameSync(dest, `${dest}.ours`);
              if (kind === "file") writeFileSync(dest, makeSolidPng(3, 3));
              else symlinkSync(sibling, dest, "file");
            },
          }),
        /not the staged file after the hand-off/,
        kind,
      );
      assert.ok(readdirSync(outReal).includes("x.png"), `${kind}: the replacement is not deleted by us`);
      assert.equal(statSync(join(outReal, "x.png.ours")).size, 0, `${kind}: our own (hard-linked) object was truncated through the staging fd`);
      assert.deepEqual(readFileSync(sibling), makeSolidPng(3, 3), `${kind}: the sibling is untouched`);
    }
  });

  test("writeImageSafely: a handed-off file swapped DURING its verification (between the fd checks and realpath) is refused", async () => {
    const { writeImageSafely, prepareOutputDir } = await importDist("mcp/image-harvest.js");
    const { outReal, outId } = prepareOutputDir(tmp("pp-img-out-"));
    const theirs = makeSolidPng(3, 3);
    let swapped = false;
    assert.throws(
      () =>
        writeImageSafely(outReal, outId, newStaging(), "x.png", makeSolidPng(2, 2), 0, {
          duringVerify: (p) => {
            if (dirname(p) !== outReal) return; // only the hand-off verification, not the staging one
            renameSync(p, `${p}.ours`);
            writeFileSync(p, theirs);
            swapped = true;
          },
        }),
      /no longer the file that was handed off/,
    );
    assert.equal(swapped, true, "the swap really happened inside verification");
    assert.deepEqual(readFileSync(join(outReal, "x.png")), theirs, "the replacement is untouched");
  });

  test("writeImageSafely: failure cleanup never deletes by pathname, even if the path is swapped right before cleanup", async () => {
    const { writeImageSafely, prepareOutputDir } = await importDist("mcp/image-harvest.js");
    const { outReal, outId } = prepareOutputDir(tmp("pp-img-out-"));
    const third = makeSolidPng(5, 5);
    assert.throws(
      () =>
        writeImageSafely(outReal, outId, newStaging(), "x.png", makeSolidPng(2, 2), 0, {
          afterHandOff: (dest) => {
            renameSync(dest, `${dest}.ours`);
            writeFileSync(dest, makeSolidPng(3, 3)); // forces a failed verification
          },
          beforeNeutralise: (dest) => {
            rmSync(dest);
            writeFileSync(dest, third); // swapped in between failure and cleanup
          },
        }),
      /not the staged file after the hand-off/,
    );
    assert.deepEqual(readFileSync(join(outReal, "x.png")), third, "the file swapped in at cleanup time survives intact");
    assert.equal(statSync(join(outReal, "x.png.ours")).size, 0, "only our own object was neutralised, through its fd");
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
function assemblePng({ width, height, bitDepth = 8, colorType = 0, interlace = 0, raw, idat, plte, splitIdatWith, extra = [] }) {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = bitDepth;
  ihdrData[9] = colorType;
  ihdrData[12] = interlace;
  const stream = idat ?? zlib.deflateSync(raw);
  // `extra`: [{ at: "ihdr" | "plte" | "idat", type, data }] — ancillary chunks placed after that chunk.
  const extras = (at) => extra.filter((e) => e.at === at).map((e) => pngChunk(e.type, e.data));
  const chunks = [SIGNATURE, pngChunk("IHDR", ihdrData), ...extras("ihdr")];
  if (plte) chunks.push(pngChunk("PLTE", plte), ...extras("plte"));
  if (splitIdatWith) {
    const half = Math.floor(stream.length / 2);
    chunks.push(pngChunk("IDAT", stream.subarray(0, half)), pngChunk(splitIdatWith, Buffer.from("Comment\0x")), pngChunk("IDAT", stream.subarray(half)));
  } else {
    chunks.push(pngChunk("IDAT", stream));
  }
  chunks.push(...extras("idat"), IEND);
  return Buffer.concat(chunks);
}

/**
 * Raw (inflated) scanlines for an 8-bit greyscale image, filter type 0. For
 * interlace=1 the Adam7 pass table is written out independently here — NOT
 * taken from the module — so the fixture does not share the code under test.
 */
function greyScanlines(width, height, interlace = 0, filter = 0, value = 90) {
  const passes = interlace
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]];
  const parts = [];
  for (const [x0, y0, dx, dy] of passes) {
    const w = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const h = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    if (!w || !h) continue;
    for (let r = 0; r < h; r++) parts.push(Buffer.from([filter]), Buffer.alloc(w, value));
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

  test("validatePngStructure validates image data: undecodable IDAT, bombs, wrong length, bad filters, chunk rules and the pixel cap", async () => {
    const { validatePngStructure } = await importDist("mcp/image-harvest.js");
    for (const interlace of [0, 1]) {
      const good = assemblePng({ width: 13, height: 11, interlace, raw: greyScanlines(13, 11, interlace) });
      const r = validatePngStructure(good);
      assert.equal(r.ok, true, `valid interlace=${interlace}: ${r.reason}`);
      assert.equal(r.interlaced, interlace === 1);
    }
    const truncatedStream = zlib.deflateSync(greyScanlines(4, 4));
    const cut = assemblePng({ width: 4, height: 4, idat: truncatedStream.subarray(0, truncatedStream.length - 3) });
    assert.equal(validatePngStructure(cut).ok, false, "a TRUNCATED zlib stream is still refused");
    const cases = {
      "CRC-correct garbage IDAT": [assemblePng({ width: 4, height: 4, idat: Buffer.from([1, 2, 3, 4]) }), /does not inflate/],
      "interlaced decompression bomb": [assemblePng({ width: 4, height: 4, interlace: 1, raw: Buffer.alloc(8 * 1024 * 1024) }), /inflates past/],
      "plain decompression bomb": [assemblePng({ width: 4, height: 4, raw: Buffer.alloc(8 * 1024 * 1024) }), /inflates past/],
      "short image data": [assemblePng({ width: 4, height: 4, raw: Buffer.alloc(10) }), /inflates to 10 bytes; IHDR implies exactly 20/],
      "bad filter byte": [assemblePng({ width: 4, height: 4, raw: greyScanlines(4, 4, 0, 5) }), /invalid scanline filter type 5/],
      "PLTE in greyscale": [assemblePng({ width: 4, height: 4, raw: greyScanlines(4, 4), plte: Buffer.alloc(3) }), /PLTE in a greyscale/],
      // A chunk between IDATs can only be ancillary (PLTE/IHDR there are refused on their own), so it is refused as such.
      "chunk between IDATs": [assemblePng({ width: 4, height: 4, raw: greyScanlines(4, 4), splitIdatWith: "tEXt" }), /ancillary chunks are not accepted/],
      "PLTE after IDAT": [assemblePng({ width: 4, height: 4, colorType: 2, raw: Buffer.concat(Array.from({ length: 4 }, () => Buffer.from([0, ...Array(12).fill(5)]))), splitIdatWith: "PLTE" }), /PLTE after IDAT/],
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

// ─── round-3 findings ────────────────────────────────────────────────────────

/** An 8-bit palette PNG whose every pixel is palette index `index`, with `entries` palette colours. */
function palettePng({ width = 5, height = 3, interlace = 0, entries, index, bitDepth = 8 }) {
  const plte = Buffer.alloc(entries * 3);
  for (let i = 0; i < entries; i++) plte.set([i * 40, 255 - i * 40, 7], i * 3);
  return assemblePng({ width, height, colorType: 3, bitDepth, interlace, plte, raw: greyScanlines(width, height, interlace, 0, index) });
}

describe("pp_codex.generate_image: round-3 findings", () => {
  test("resolveSessionDir: an identity-preserving swap (rename the dir, link the old name to it) is refused", async () => {
    const { resolveSessionDir } = await importDist("mcp/image-harvest.js");
    const root = tmp("pp-img-root-");
    const sessionId = newSessionId();
    const renamedTo = join(root, newSessionId());
    mkdirSync(join(root, sessionId));
    const r = resolveSessionDir(root, sessionId, {
      afterLstat: (candidate) => {
        renameSync(candidate, renamedTo); // same dev+ino, different name
        symlinkSync(renamedTo, candidate, "junction");
      },
    });
    assert.equal(r.kind, "rejected");
    assert.match(r.reason, /not to itself|no longer the plain directory/);
  });

  test("resolveSessionDir: resolution must land on <root>/<sessionId> itself (basename binding)", async () => {
    const { resolveSessionDir } = await importDist("mcp/image-harvest.js");
    const root = tmp("pp-img-root-");
    const sessionId = newSessionId();
    const renamedTo = join(root, newSessionId());
    mkdirSync(join(root, sessionId));
    // Swap so realpath lands on the renamed dir, then put the plain dir back:
    // only the basename binding can tell that realpath resolved elsewhere.
    const r = resolveSessionDir(root, sessionId, {
      afterLstat: (candidate) => {
        renameSync(candidate, renamedTo);
        symlinkSync(renamedTo, candidate, "junction");
      },
      afterRealpath: (candidate) => {
        rmSync(candidate);
        renameSync(renamedTo, candidate);
      },
    });
    assert.equal(r.kind, "rejected");
    assert.match(r.reason, /not to itself/);
  });

  test("resolveSessionDir: the candidate is re-checked after realpath (re-lstat identity)", async () => {
    const { resolveSessionDir } = await importDist("mcp/image-harvest.js");
    const root = tmp("pp-img-root-");
    const sessionId = newSessionId();
    mkdirSync(join(root, sessionId));
    const r = resolveSessionDir(root, sessionId, {
      afterRealpath: (candidate) => {
        renameSync(candidate, `${candidate}-moved`);
        mkdirSync(candidate); // same name, plain, different identity
      },
    });
    assert.equal(r.kind, "rejected");
    assert.match(r.reason, /no longer the plain directory first seen/);
  });

  test("acceptPng: valid palette images (plain and Adam7) are accepted; out-of-range palette indices are refused", async () => {
    const { acceptPng } = await importDist("mcp/image-harvest.js");
    for (const interlace of [0, 1]) {
      const good = acceptPng(palettePng({ interlace, entries: 2, index: 1 }));
      assert.equal(good.ok, true, `valid palette interlace=${interlace}: ${good.reason}`);
      const bad = acceptPng(palettePng({ interlace, entries: 1, index: 1 }));
      assert.equal(bad.ok, false, `index 1 with a 1-entry palette, interlace=${interlace}`);
      assert.match(bad.reason, /does not decode/);
    }
  });

  test("validatePngStructure: unknown critical chunks, any ancillary chunk and oversized palettes are refused", async () => {
    const { validatePngStructure } = await importDist("mcp/image-harvest.js");
    const withAncillary = assemblePng({ width: 4, height: 4, raw: greyScanlines(4, 4), splitIdatWith: undefined });
    assert.equal(validatePngStructure(withAncillary).ok, true, "precondition: the critical-only base is accepted");
    const ancillary = Buffer.concat([withAncillary.subarray(0, 33), pngChunk("abCD", Buffer.from("x")), withAncillary.subarray(33)]);
    const ra = validatePngStructure(ancillary);
    assert.equal(ra.ok, false, "an ancillary chunk is refused");
    assert.match(ra.reason, /ancillary chunks are not accepted/);
    const critical = Buffer.concat([withAncillary.subarray(0, 33), pngChunk("ABCD", Buffer.from("x")), withAncillary.subarray(33)]);
    const rc = validatePngStructure(critical);
    assert.equal(rc.ok, false);
    assert.match(rc.reason, /unknown critical chunk ABCD/);
    const big = palettePng({ width: 8, height: 1, bitDepth: 1, entries: 3, index: 0 });
    const rp = validatePngStructure(big);
    assert.equal(rp.ok, false);
    assert.match(rp.reason, /allows at most 2/);
  });

  test("end to end: an out-of-range-palette PNG that fits as-is is never copied; a valid palette PNG is copied byte-for-byte", async () => {
    const goodPalette = palettePng({ interlace: 1, entries: 2, index: 1 });
    const { result, outputDir } = await runHarvest({
      write: writePngs({
        "exec-call-badpal.png": palettePng({ entries: 1, index: 1 }),
        "exec-call-pal.png": goodPalette,
      }),
    });
    assert.equal(result.status, "partial");
    assert.deepEqual(readdirSync(outputDir), ["exec-call-pal.png"]);
    assert.deepEqual(readFileSync(join(outputDir, "exec-call-pal.png")), goodPalette, "palette + Adam7 preserved verbatim");
    assert.match(result.failures.find((f) => f.file === "exec-call-badpal.png")?.reason ?? "", /malformed PNG: does not decode/);
  });
});

// ─── round-5 findings ────────────────────────────────────────────────────────

describe("pp_codex.generate_image: round-5 findings", () => {
  test("final-IDAT padding after the zlib stream is legal: accepted and copied byte-for-byte", async () => {
    const { validatePngStructure, acceptPng } = await importDist("mcp/image-harvest.js");
    const padded = assemblePng({ width: 4, height: 4, idat: Buffer.concat([zlib.deflateSync(greyScanlines(4, 4)), Buffer.from([0, 0])]) });
    assert.doesNotThrow(() => PNG.sync.read(padded), "oracle: pngjs decodes the padded fixture");
    assert.equal(validatePngStructure(padded).ok, true, validatePngStructure(padded).reason);
    assert.equal(acceptPng(padded).ok, true);
    const { result } = await runHarvest({ write: writePngs({ "exec-call-padded.png": padded }) });
    assert.equal(result.status, "ok", JSON.stringify(result.failures));
    assert.deepEqual(readFileSync(result.images[0].path), padded);
  });

  test("source: a replacement present for the open and restored before realpath is refused (path re-checked against the fd last)", async () => {
    // Staged at file level: Windows refuses to rename a DIRECTORY that holds
    // our open fd (EPERM), so the directory-level variant cannot even be set
    // up there. Both variants are caught by the same final lstat-vs-fd check.
    const foreign = makeSolidPng(4, 4, [0, 255, 0, 255]);
    const { result, outputDir } = await runHarvest({
      write: writePngs({ "exec-call-1.png": makeSolidPng(4, 4) }),
      opts: {
        _fileHooks: {
          beforeOpen: (p) => {
            renameSync(p, `${p}.orig`);
            writeFileSync(p, foreign); // the replacement the open will see
          },
          afterFirstCheck: (p) => {
            renameSync(p, `${p}.foreign`);
            renameSync(`${p}.orig`, p); // restore the original before realpath
          },
        },
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.failures[0].reason, /no longer denotes the opened file/);
    assert.deepEqual(readdirSync(outputDir), [], "the foreign bytes were never written out");
  });

  test("output: output_dir swapped after all resolution (our file moved into a new dir) is refused by the final identity check", async () => {
    const { writeImageSafely, prepareOutputDir } = await importDist("mcp/image-harvest.js");
    const base = tmp("pp-img-outbase-");
    const { outReal, outId } = prepareOutputDir(join(base, "out"));
    let staged = false;
    assert.throws(
      () =>
        writeImageSafely(outReal, outId, newStaging(), "x.png", makeSolidPng(2, 2), 0, {
          afterResolve: (dest) => {
            if (dirname(dest) !== outReal) return; // only the hand-off verification
            // Move our (open) file out first — Windows forbids renaming a
            // directory that holds an open file — then swap the directory and
            // move the file back: file identity is unchanged, so only the
            // final DIRECTORY identity check can catch this.
            renameSync(dest, join(base, "x.parked"));
            renameSync(outReal, `${outReal}-moved`);
            mkdirSync(outReal);
            renameSync(join(base, "x.parked"), dest);
            staged = true;
          },
        }),
      /replaced by a different directory/,
    );
    assert.equal(staged, true, "the swap really happened after resolution");
  });

  test("output: a parent swapped for a junction right before the hand-off is detected, refused, and the object neutralised through the staging fd", async () => {
    const { writeImageSafely, prepareOutputDir } = await importDist("mcp/image-harvest.js");
    const escape = tmp("pp-img-escape-");
    const { outReal, outId } = prepareOutputDir(join(tmp("pp-img-outbase-"), "out"));
    assert.throws(
      () =>
        writeImageSafely(outReal, outId, newStaging(), "x.png", makeSolidPng(2, 2), 0, {
          beforeHandOff: () => {
            rmSync(outReal, { recursive: true });
            symlinkSync(escape, outReal, "junction");
          },
        }),
      (err) => {
        assert.match(err.message, /outside output_dir|no longer resolves to itself/);
        assert.match(err.message, /truncated through its fd/);
        return true;
      },
    );
    assert.deepEqual(readdirSync(escape), ["x.png"], "precondition: the hand-off really was redirected into the junction target (the stated residual)");
    assert.equal(statSync(join(escape, "x.png")).size, 0, "the redirected object IS the staged inode and was truncated through the staging fd");
  });
});

// ─── staging + exclusive hand-off ─────────────────────────────────────────────

describe("pp_codex.generate_image: private staging and exclusive hand-off", () => {
  test("a staged file relocated into output_dir during the staging write cannot leave content there", async () => {
    const { writeImageSafely, prepareOutputDir } = await importDist("mcp/image-harvest.js");
    const { outReal, outId } = prepareOutputDir(tmp("pp-img-out-"));
    assert.throws(
      () =>
        writeImageSafely(outReal, outId, newStaging(), "x.png", makeSolidPng(2, 2), 0, {
          afterWrite: (stagedPath) => renameSync(stagedPath, join(outReal, "stolen.png")),
        }),
      /no longer the file that was written/,
    );
    const left = readdirSync(outReal);
    assert.deepEqual(left, ["stolen.png"], "precondition: the relocation really put the staged object in output_dir");
    assert.equal(statSync(join(outReal, "stolen.png")).size, 0, "the relocated object was neutralised through the staging fd");
  });

  test("end to end: relocation during staging leaves no content in output_dir and no image is reported", async () => {
    const outputDir = tmp("pp-img-out-");
    const { result } = await runHarvest({
      args: { output_dir: outputDir },
      write: writePngs({ "exec-call-1.png": makeSolidPng(4, 4) }),
      opts: { _writeHooks: { afterWrite: (stagedPath) => renameSync(stagedPath, join(real(outputDir), "stolen.png")) } },
    });
    assert.equal(result.status, "failed");
    for (const f of readdirSync(outputDir)) assert.equal(statSync(join(outputDir, f)).size, 0, `${f} must hold no content`);
  });

  test("staged bytes altered in place (same inode, same size) are caught by the read-back comparison before any hand-off", async () => {
    const { writeImageSafely, prepareOutputDir } = await importDist("mcp/image-harvest.js");
    const { outReal, outId } = prepareOutputDir(tmp("pp-img-out-"));
    const png = makeSolidPng(2, 2);
    assert.throws(
      () =>
        writeImageSafely(outReal, outId, newStaging(), "x.png", png, 0, {
          afterWrite: (stagedPath) => {
            const fd = openSync(stagedPath, "r+");
            try { writeSync(fd, Buffer.from([0x00]), 0, 1, png.length - 1); } finally { closeSync(fd); }
          },
        }),
      /staged bytes differ from the verified image/,
    );
    assert.deepEqual(readdirSync(outReal), [], "nothing was handed off");
  });

  test("a handed-off file altered in place (same identity, same size) is refused by the byte comparison", async () => {
    const { writeImageSafely, prepareOutputDir } = await importDist("mcp/image-harvest.js");
    const png = makeSolidPng(2, 2);
    const { outReal, outId } = prepareOutputDir(tmp("pp-img-out-"));
    assert.throws(
      () =>
        writeImageSafely(outReal, outId, newStaging(), "x.png", png, 0, {
          afterHandOff: (dest) => {
            const fd = openSync(dest, "r+");
            try { writeSync(fd, Buffer.from([0x00]), 0, 1, png.length - 1); } finally { closeSync(fd); }
          },
        }),
      /does not hold the handed-off bytes/,
    );
  });

  test("hand-off refuses a pre-existing file, symlink or dangling symlink at the target name; nothing is created through a link", async () => {
    const { writeImageSafely, prepareOutputDir } = await importDist("mcp/image-harvest.js");
    for (const kind of ["file", "symlink", "dangling"]) {
      const { outReal, outId } = prepareOutputDir(tmp("pp-img-out-"));
      const escape = tmp("pp-img-escape-");
      const canary = join(escape, "canary.txt");
      writeFileSync(canary, "do-not-touch");
      if (kind === "file") writeFileSync(join(outReal, "x.png"), "existing");
      else symlinkSync(kind === "symlink" ? canary : join(escape, "missing.txt"), join(outReal, "x.png"), "file");
      assert.throws(() => writeImageSafely(outReal, outId, newStaging(), "x.png", makeSolidPng(2, 2), 0), /collision cap reached/, kind);
      assert.equal(readFileSync(canary, "utf8"), "do-not-touch", `${kind}: link target untouched`);
      assert.deepEqual(readdirSync(escape), ["canary.txt"], `${kind}: nothing created through the link (a dangling link's target stays absent)`);
      if (kind === "file") assert.equal(readFileSync(join(outReal, "x.png"), "utf8"), "existing", `${kind}: existing file untouched`);
      const path = writeImageSafely(outReal, outId, newStaging(), "x.png", makeSolidPng(2, 2), 1);
      assert.equal(path, join(outReal, "x-1.png"), `${kind}: the next free name is used`);
    }
  });

  test("the hand-off is a hard link of the verified staged inode", async () => {
    const { writeImageSafely, prepareOutputDir } = await importDist("mcp/image-harvest.js");
    const png = makeSolidPng(3, 2);
    const { outReal, outId } = prepareOutputDir(tmp("pp-img-out-"));
    const staging = newStaging();
    const path = writeImageSafely(outReal, outId, staging, "x.png", png, 0);
    assert.deepEqual(readFileSync(path), png);
    const stagedNames = readdirSync(staging.dirReal);
    assert.equal(stagedNames.length, 1, "exactly one staged file");
    assert.equal(statSync(join(staging.dirReal, stagedNames[0]), { bigint: true }).ino, statSync(path, { bigint: true }).ino, "same inode");
  });

  test("fail closed: when a hard link is impossible (EXDEV / EPERM) there is no copy fallback and nothing reaches output_dir", async () => {
    const { writeImageSafely, prepareOutputDir } = await importDist("mcp/image-harvest.js");
    for (const code of ["EXDEV", "EPERM"]) {
      const { outReal, outId } = prepareOutputDir(tmp("pp-img-out-"));
      assert.throws(
        () => writeImageSafely(outReal, outId, newStaging(), "x.png", makeSolidPng(2, 2), 0, { linkError: code }),
        new RegExp(`hand-off refused: a hard link into output_dir failed \\(${code}\\); there is deliberately no copy fallback`),
      );
      assert.deepEqual(readdirSync(outReal), [], `${code}: nothing was written into output_dir`);
    }
    const outputDir = tmp("pp-img-out-");
    const { result } = await runHarvest({
      args: { output_dir: outputDir },
      write: writePngs({ "exec-call-1.png": makeSolidPng(4, 4) }),
      opts: { _writeHooks: { linkError: "EXDEV" } },
    });
    assert.equal(result.status, "failed");
    assert.match(result.failures[0].reason, /no copy fallback/);
    assert.deepEqual(readdirSync(outputDir), []);
  });

  test("createStagingDir: a failure after allocation deletes nothing — the allocated directory is retained and named", async () => {
    const { createStagingDir } = await importDist("mcp/image-harvest.js");
    const parent = join(tmp("pp-img-stagebase-"), "image-staging");
    let allocated;
    const r = createStagingDir(parent, {
      afterMkdtemp: (dir) => {
        allocated = dir;
        throw Object.assign(new Error("forced EIO"), { code: "EIO" });
      },
    });
    assert.equal(r.ok, false);
    assert.ok(allocated, "precondition: a directory really was allocated before the failure");
    assert.match(r.reason, /forced EIO.*is retained by design and will be swept once stale/);
    assert.ok(r.reason.includes(allocated), "the retained directory is named");
    assert.ok(statSync(allocated).isDirectory(), "and it was not deleted");
  });

  test("createStagingDir refuses a linked staging parent; assertStagingIntact refuses a replaced staging dir", async () => {
    const { createStagingDir, assertStagingIntact } = await importDist("mcp/image-harvest.js");
    const escape = tmp("pp-img-escape-");
    const linkedParent = join(tmp("pp-img-stagebase-"), "image-staging");
    symlinkSync(escape, linkedParent, "junction");
    const r = createStagingDir(linkedParent);
    assert.equal(r.ok, false);
    assert.match(r.reason, /not a plain directory/);
    assert.deepEqual(readdirSync(escape), [], "nothing created through the linked parent");

    const s = newStaging();
    assert.doesNotThrow(() => assertStagingIntact(s));
    renameSync(s.dirReal, `${s.dirReal}-orig`);
    mkdirSync(s.dirReal);
    assert.throws(() => assertStagingIntact(s), /staging directory .* was replaced/);
  });

  test("end to end: the call deletes nothing — its staging directory (with the staged image) is retained and reported", async () => {
    const stagingParent = join(tmp("pp-img-stagebase-"), "image-staging");
    const { result } = await runHarvest({ write: writePngs({ "exec-call-1.png": makeSolidPng(4, 4) }), opts: { _stagingParent: stagingParent } });
    assert.equal(result.status, "ok");
    assert.ok(result.staging_dir, "the staging directory is reported");
    assert.equal(dirname(result.staging_dir), real(stagingParent));
    assert.equal(readdirSync(result.staging_dir).length, 1, "the staged image is still there: nothing was deleted during the call");
  });

  test("sweepStagingDirs removes only STALE staging directories, and a later call sweeps an earlier call's directory", async () => {
    const { sweepStagingDirs, STAGING_SWEEP_AGE_MS } = await importDist("mcp/image-harvest.js");
    const stagingParent = join(tmp("pp-img-stagebase-"), "image-staging");
    const first = await runHarvest({ write: writePngs({ "exec-call-1.png": makeSolidPng(4, 4) }), opts: { _stagingParent: stagingParent } });
    const oldDir = first.result.staging_dir;
    const fresh = sweepStagingDirs(stagingParent);
    assert.deepEqual(fresh.removed, [], "a fresh staging directory is not swept");
    const old = new Date(Date.now() - STAGING_SWEEP_AGE_MS - 60_000);
    utimesSync(oldDir, old, old);
    const second = await runHarvest({ write: writePngs({ "exec-call-1.png": makeSolidPng(4, 4) }), opts: { _stagingParent: stagingParent } });
    assert.equal(lstatSync(oldDir, { throwIfNoEntry: false }), undefined, "the stale directory was swept at the start of the later call");
    assert.deepEqual(readdirSync(stagingParent), [basename(second.result.staging_dir)], "only the later call's own directory remains");
  });

  test("sweep: a file replaced AFTER it was observed is moved aside and left in place, never deleted", async () => {
    const { sweepStagingDirs, createStagingDir } = await importDist("mcp/image-harvest.js");
    const parent = join(tmp("pp-img-stagebase-"), "image-staging");
    const { staging } = createStagingDir(parent);
    writeFileSync(join(staging.dirReal, "staged.png"), "ours");
    const old = new Date(Date.now() - 48 * 3600_000);
    utimesSync(staging.dirReal, old, old);
    const report = sweepStagingDirs(parent, undefined, {
      afterObserve: (p) => {
        if (!p.endsWith("staged.png")) return;
        rmSync(p);
        writeFileSync(p, "theirs"); // swapped in after the sweep's lstat
      },
    });
    assert.deepEqual(report.removed, []);
    assert.match(report.skipped[0]?.reason ?? "", /replaced after it was observed; .* left in place/);
    const aside = report.skipped[0].path;
    assert.equal(readFileSync(aside, "utf8"), "theirs", "the replacement survives (moved aside, not deleted)");
  });

  test("sweep: a staging DIRECTORY replaced after it was observed is moved aside and left in place, never deleted", async () => {
    const { sweepStagingDirs, createStagingDir } = await importDist("mcp/image-harvest.js");
    const parent = join(tmp("pp-img-stagebase-"), "image-staging");
    const { staging } = createStagingDir(parent);
    const old = new Date(Date.now() - 48 * 3600_000);
    utimesSync(staging.dirReal, old, old);
    const report = sweepStagingDirs(parent, undefined, {
      afterObserve: (p) => {
        if (p !== staging.dirReal) return;
        renameSync(p, `${p}-orig`);
        mkdirSync(p);
        writeFileSync(join(p, "theirs.txt"), "keep");
      },
    });
    assert.deepEqual(report.removed, []);
    assert.match(report.skipped[0]?.reason ?? "", /was replaced after it was observed/);
    assert.equal(readFileSync(join(report.skipped[0].path, "theirs.txt"), "utf8"), "keep", "the replacement directory and its content survive");
    assert.ok(statSync(`${staging.dirReal}-orig`).isDirectory(), "the original is untouched too");
  });

  test("sweep: a staging PARENT swapped for a junction mid-sweep stops the whole sweep — nothing behind the link is renamed or deleted", async () => {
    const { sweepStagingDirs } = await importDist("mcp/image-harvest.js");
    const base = tmp("pp-img-stagebase-");
    const parent = join(base, "image-staging");
    const escape = tmp("pp-img-escape-");
    const old = new Date(Date.now() - 48 * 3600_000);
    for (const root of [parent, escape]) {
      for (const n of ["gi-a", "gi-b"]) {
        mkdirSync(join(root, n), { recursive: true });
        writeFileSync(join(root, n, "f.txt"), root === escape ? "victim" : "ours");
        utimesSync(join(root, n), old, old);
      }
    }
    let swapped = false;
    const report = sweepStagingDirs(parent, undefined, {
      afterObserve: () => {
        if (swapped) return;
        swapped = true;
        renameSync(parent, `${parent}-orig`);
        symlinkSync(escape, parent, "junction");
      },
    });
    assert.equal(swapped, true, "precondition: the parent really was swapped after the first observation");
    assert.deepEqual(report.removed, []);
    assert.ok(report.skipped.some((s) => /sweep STOPPED \(fail closed\)/.test(s.reason)), JSON.stringify(report.skipped));
    assert.deepEqual(readdirSync(escape).sort(), ["gi-a", "gi-b"], "nothing behind the link was renamed");
    for (const n of ["gi-a", "gi-b"]) assert.equal(readFileSync(join(escape, n, "f.txt"), "utf8"), "victim", `${n} intact`);
  });

  test("sweep: a moved-aside directory swapped for a junction to a hard link of the SAME file stops the sweep — the outside name survives", async () => {
    const { sweepStagingDirs } = await importDist("mcp/image-harvest.js");
    const parent = join(tmp("pp-img-stagebase-"), "image-staging");
    mkdirSync(join(parent, "gi-a"), { recursive: true });
    writeFileSync(join(parent, "gi-a", "f.png"), "ours");
    const old = new Date(Date.now() - 48 * 3600_000);
    utimesSync(join(parent, "gi-a"), old, old);
    const escape = tmp("pp-img-escape-");
    let staged = false;
    const report = sweepStagingDirs(parent, undefined, {
      afterObserve: (p) => {
        if (!p.endsWith("f.png") || staged) return;
        staged = true;
        const moved = dirname(p);
        renameSync(moved, `${moved}-orig`);
        // Same inode under an OUTSIDE name: identity checks on the file alone would pass.
        linkSync(join(`${moved}-orig`, "f.png"), join(escape, "f.png"));
        symlinkSync(escape, moved, "junction");
      },
    });
    assert.equal(staged, true, "precondition: the swap really happened");
    assert.ok(report.skipped.some((s) => /sweep STOPPED \(fail closed\)/.test(s.reason)), JSON.stringify(report.skipped));
    assert.equal(readFileSync(join(escape, "f.png"), "utf8"), "ours", "the outside name was neither renamed nor deleted");
  });

  test("sweep: listings read at most 200 entries; a staging directory reaching 200 is skipped without reading more", async () => {
    const { sweepStagingDirs, boundedNames, MAX_SWEEP_ENTRIES } = await importDist("mcp/image-harvest.js");
    const listDir = tmp("pp-img-list-");
    for (let i = 0; i < 5; i++) writeFileSync(join(listDir, `f${i}`), "");
    assert.equal(boundedNames(listDir, 3).length, 3);
    assert.equal(boundedNames(listDir, 10).length, 5);
    const parent = join(tmp("pp-img-stagebase-"), "image-staging");
    const old = new Date(Date.now() - 48 * 3600_000);
    for (const [n, count] of [["gi-full", MAX_SWEEP_ENTRIES], ["gi-small", MAX_SWEEP_ENTRIES - 1]]) {
      mkdirSync(join(parent, n), { recursive: true });
      for (let i = 0; i < count; i++) writeFileSync(join(parent, n, `f${i}`), "");
      utimesSync(join(parent, n), old, old);
    }
    const report = sweepStagingDirs(parent);
    assert.deepEqual(report.removed.map((p) => basename(p)), ["gi-small"], "199 entries: swept");
    assert.ok(report.skipped.some((s) => /listing reached 200 entries/.test(s.reason)), "200 entries: skipped, left in place");
  });

  test("sweep: links and unexpected entries are skipped and logged, never followed or deleted", async () => {
    const { sweepStagingDirs, createStagingDir } = await importDist("mcp/image-harvest.js");
    const parent = join(tmp("pp-img-stagebase-"), "image-staging");
    const { staging } = createStagingDir(parent);
    const escape = tmp("pp-img-escape-");
    writeFileSync(join(escape, "victim.txt"), "keep");
    symlinkSync(escape, join(parent, "gi-linked"), "junction");
    mkdirSync(join(staging.dirReal, "subdir"));
    const old = new Date(Date.now() - 48 * 3600_000);
    utimesSync(staging.dirReal, old, old);
    lutimesSync(join(parent, "gi-linked"), old, old); // the LINK itself looks stale, so only the link check can stop the sweep
    const report = sweepStagingDirs(parent);
    assert.deepEqual(report.removed, []);
    assert.ok(report.skipped.some((s) => s.path === join(real(parent), "gi-linked") && /link/.test(s.reason)));
    assert.ok(report.skipped.some((s) => /not a regular file/.test(s.reason)));
    assert.equal(readFileSync(join(escape, "victim.txt"), "utf8"), "keep", "nothing deleted through the link");
  });
});

// ─── lead review findings: ancillary chunks ───────────────────────────────────

const u32 = (...vals) => { const b = Buffer.alloc(4 * vals.length); vals.forEach((v, i) => b.writeUInt32BE(v, i * 4)); return b; };
const RGBA_1x1 = { width: 1, height: 1, colorType: 6, raw: Buffer.from([0, 10, 20, 30, 255]) };
const GREY_4x4 = { width: 4, height: 4, colorType: 0, raw: greyScanlines(4, 4) };
const RGB_2x1 = { width: 2, height: 1, colorType: 2, raw: Buffer.from([0, 1, 2, 3, 4, 5, 6]) };
const PAL_2x1 = { width: 2, height: 1, colorType: 3, raw: Buffer.from([0, 0, 1]), plte: Buffer.from([255, 0, 0, 0, 255, 0]) };

describe("pp_codex.generate_image: only critical chunks are accepted", () => {
  test("acceptPng accepts PNGs made only of IHDR/PLTE/IDAT/IEND (greyscale, RGB, RGBA, palette, Adam7) and pngjs decodes them", async () => {
    const { acceptPng } = await importDist("mcp/image-harvest.js");
    const good = [
      assemblePng(GREY_4x4),
      assemblePng(RGB_2x1),
      assemblePng(RGBA_1x1),
      assemblePng(PAL_2x1),
      assemblePng({ ...RGB_2x1, plte: Buffer.from([1, 2, 3]) }), // suggested palette on an RGB image
      assemblePng({ width: 13, height: 11, interlace: 1, raw: greyScanlines(13, 11, 1) }),
    ];
    for (const [i, buf] of good.entries()) {
      assert.doesNotThrow(() => PNG.sync.read(buf), `oracle: pngjs decodes fixture ${i}`);
      const r = acceptPng(buf);
      assert.equal(r.ok, true, `critical-only fixture ${i}: ${r.reason}`);
    }
  });

  test("acceptPng refuses ANY ancillary chunk — including every counterexample from earlier review rounds", async () => {
    const { acceptPng } = await importDist("mcp/image-harvest.js");
    const anc = (base, at, type, data) => assemblePng({ ...base, extra: [{ at, type, data }] });
    const cases = {
      // round D counterexamples
      "gAMA = 0xffffffff": anc(GREY_4x4, "ihdr", "gAMA", u32(0xffffffff)),
      "cHRM components = 0xffffffff": anc(GREY_4x4, "ihdr", "cHRM", u32(...Array(8).fill(0xffffffff))),
      "pHYs density = 0xffffffff": anc(GREY_4x4, "ihdr", "pHYs", Buffer.concat([u32(0xffffffff, 0xffffffff), Buffer.from([1])])),
      "iTXt language tag --": anc(GREY_4x4, "idat", "iTXt", Buffer.from("Title\0\0\0--\0\0x")),
      "sRGB with gAMA = 1": assemblePng({ ...RGB_2x1, extra: [{ at: "ihdr", type: "sRGB", data: Buffer.from([0]) }, { at: "ihdr", type: "gAMA", data: u32(1) }] }),
      // earlier rounds
      "tRNS on 1x1 RGBA": anc(RGBA_1x1, "ihdr", "tRNS", Buffer.from([0, 0])),
      "5-byte gAMA": anc(GREY_4x4, "ihdr", "gAMA", Buffer.alloc(5)),
      "iCCP with non-zlib bytes": anc(RGB_2x1, "ihdr", "iCCP", Buffer.from("p\0\0xx")),
      "zTXt with no stream": anc(GREY_4x4, "idat", "zTXt", Buffer.from("Comment\0\0")),
      "eXIf prefix only": anc(GREY_4x4, "ihdr", "eXIf", Buffer.from("MM\0*")),
      "tEXt keyword with a control byte": anc(GREY_4x4, "idat", "tEXt", Buffer.from("Com\x01ment\0x", "latin1")),
      "tIME 2026-02-29": anc(GREY_4x4, "ihdr", "tIME", Buffer.from([0x07, 0xea, 2, 29, 0, 0, 0])),
      // and perfectly well-formed metadata is refused too
      "well-formed tEXt": anc(GREY_4x4, "idat", "tEXt", Buffer.from("Comment\0ok")),
      "well-formed gAMA": anc(GREY_4x4, "ihdr", "gAMA", u32(45455)),
      "unknown ancillary type": anc(GREY_4x4, "ihdr", "vpAg", Buffer.alloc(9)),
    };
    for (const [label, buf] of Object.entries(cases)) {
      const r = acceptPng(buf);
      assert.equal(r.ok, false, `${label} must be refused`);
      assert.match(r.reason, /ancillary chunks are not accepted \(only IHDR, PLTE, IDAT and IEND\)/, label);
    }
  });

  test("end to end: a PNG carrying an ancillary chunk that fits as-is is never copied", async () => {
    const { result, outputDir } = await runHarvest({
      write: writePngs({
        "exec-call-meta.png": assemblePng({ ...GREY_4x4, extra: [{ at: "ihdr", type: "gAMA", data: u32(45455) }] }),
        "exec-call-plain.png": assemblePng(GREY_4x4),
      }),
    });
    assert.equal(result.status, "partial");
    assert.deepEqual(readdirSync(outputDir), ["exec-call-plain.png"]);
    assert.match(result.failures.find((f) => f.file === "exec-call-meta.png")?.reason ?? "", /ancillary chunks are not accepted/);
  });
});

// ─── lead review findings: settle binding and cumulative budgets ──────────────

describe("pp_codex.generate_image: settle observation and per-call budgets", () => {
  test("a settled red PNG replaced by a complete green PNG (fresh mtime) before the final open is refused", async () => {
    const green = makeSolidPng(4, 4, [0, 255, 0, 255]);
    const { result, outputDir } = await runHarvest({
      write: writePngs({ "exec-call-1.png": makeSolidPng(4, 4, [255, 0, 0, 255]) }),
      opts: {
        _fileHooks: {
          beforeOpen: (p) => {
            rmSync(p);
            writeFileSync(p, green); // complete, valid, fresh mtime — never observed by a settle poll
          },
        },
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.failures[0].reason, /changed since it settled/);
    assert.deepEqual(readdirSync(outputDir), [], "the unobserved replacement was never accepted");
  });

  test("writeImageSafely: a failed truncation is reported as such, with the remaining content described as unknown", async () => {
    const { writeImageSafely, prepareOutputDir } = await importDist("mcp/image-harvest.js");
    const { outReal, outId } = prepareOutputDir(tmp("pp-img-out-"));
    const forced = (fn) =>
      assert.throws(
        () =>
          writeImageSafely(outReal, outId, newStaging(), "x.png", makeSolidPng(2, 2), 0, {
            afterHandOff: (dest) => { renameSync(dest, `${dest}.ours`); writeFileSync(dest, "theirs"); },
            truncate: fn,
          }),
        (err) => {
          assert.match(err.message, /truncating our bytes through the fd FAILED \(EIO\)/);
          assert.match(err.message, /content .* is UNKNOWN/);
          assert.doesNotMatch(err.message, /were truncated through its fd/, "never claims a truncation that did not happen");
          return true;
        },
      );
    forced(() => { const e = new Error("io"); e.code = "EIO"; throw e; });
    assert.ok(statSync(join(outReal, "x.png.ours")).size > 0, "precondition: the forced failure really left our bytes in place");
  });

  test("end to end: a source file modified while it is being read is refused", async () => {
    const { result, outputDir } = await runHarvest({
      write: writePngs({ "exec-call-1.png": makeSolidPng(4, 4) }),
      opts: { _fileHooks: { afterRead: (p) => appendFileSync(p, Buffer.from([0])) } },
    });
    assert.equal(result.status, "failed");
    assert.match(result.failures[0].reason, /changed while it was being read/);
    assert.deepEqual(readdirSync(outputDir), []);
  });

  test("assertFdUnchanged: a file that changes after the observation is refused", async () => {
    const { assertFdUnchanged } = await importDist("mcp/image-harvest.js");
    const dir = tmp("pp-img-fd-");
    const p = join(dir, "a.png");
    writeFileSync(p, makeSolidPng(2, 2));
    const fd = openSync(p, "r");
    try {
      const s = statSync(p, { bigint: true });
      const obs = { dev: s.dev, ino: s.ino, size: Number(s.size), mtimeMs: Number(s.mtimeMs) };
      assert.doesNotThrow(() => assertFdUnchanged(fd, obs));
      appendFileSync(p, Buffer.from([1, 2, 3]));
      assert.throws(() => assertFdUnchanged(fd, obs), /changed while it was being read/);
    } finally {
      closeSync(fd);
    }
  });

  test("cumulative entry budget: polling stops once 1000 directory entries have been examined across polls", async () => {
    const { pollForSettledPngs, MAX_DIR_ENTRIES_PER_CALL } = await importDist("mcp/image-harvest.js");
    const root = tmp("pp-img-root-");
    const sessionId = newSessionId();
    const dir = join(root, sessionId);
    mkdirSync(dir);
    for (let i = 0; i < 150; i++) writeFileSync(join(dir, `pad-${i}.txt`), "");
    writeFileSync(join(dir, "never-settles.png"), make24ByteHeaderPng()); // keeps polling alive
    const r = await pollForSettledPngs(root, sessionId, { timeoutMs: 60_000, intervalMs: 1 }); // only the budget can stop it, however loaded the machine
    assert.equal(r.kind, "ok");
    assert.equal(r.budgetExhausted, "entries");
    assert.equal(r.entriesExamined, MAX_DIR_ENTRIES_PER_CALL, "151 entries per poll would have reached ~4500 over 30 polls");
    assert.match(r.unsettled[0]?.reason ?? "", /directory-entry budget \(1000\) exhausted/);
  });

  test("cumulative open budget: at most 180 opens across polls, then polling stops", async () => {
    const { pollForSettledPngs, MAX_POLL_OPENS_PER_CALL } = await importDist("mcp/image-harvest.js");
    const root = tmp("pp-img-root-");
    const sessionId = newSessionId();
    const files = {};
    for (let i = 0; i < 20; i++) files[`p${String(i).padStart(2, "0")}.png`] = make24ByteHeaderPng();
    writePngs(files)(join(root, sessionId));
    const r = await pollForSettledPngs(root, sessionId, { timeoutMs: 60_000, intervalMs: 1 }); // only the budget can stop it, however loaded the machine
    assert.equal(r.kind, "ok");
    assert.equal(r.budgetExhausted, "opens");
    assert.equal(r.opens, MAX_POLL_OPENS_PER_CALL, "20 files x 30 polls would have been 600 opens");
    assert.ok(r.unsettled.some((u) => /open budget \(180\) exhausted/.test(u.reason)));
  });

  test("poll cap: a file that never settles is polled at most 30 times, however generous the deadline", async () => {
    const { pollForSettledPngs, MAX_SETTLE_POLLS } = await importDist("mcp/image-harvest.js");
    const root = tmp("pp-img-root-");
    const sessionId = newSessionId();
    writePngs({ "a.png": make24ByteHeaderPng() })(join(root, sessionId));
    const r = await pollForSettledPngs(root, sessionId, { timeoutMs: 60_000, intervalMs: 1 });
    assert.equal(MAX_SETTLE_POLLS, 30);
    assert.equal(r.polls, MAX_SETTLE_POLLS);
    assert.equal(r.opens, MAX_SETTLE_POLLS, "one open per poll");
  });

  test("deadline: no poll starts after the deadline", async () => {
    const { pollForSettledPngs } = await importDist("mcp/image-harvest.js");
    const root = tmp("pp-img-root-");
    const sessionId = newSessionId();
    writePngs({ "a.png": make24ByteHeaderPng() })(join(root, sessionId));
    const r = await pollForSettledPngs(root, sessionId, { timeoutMs: 250, intervalMs: 100 });
    assert.ok(r.lastPollStartMs <= r.deadlineMs, `last poll started ${r.lastPollStartMs - r.deadlineMs}ms after the deadline`);
    assert.ok(r.polls <= 3, `${r.polls} polls in a 250ms window at 100ms`);
  });

  test("deadline: a sleep that overruns the deadline does not start another poll (timer firing late under load)", async () => {
    const { pollForSettledPngs } = await importDist("mcp/image-harvest.js");
    const root = tmp("pp-img-root-");
    const sessionId = newSessionId();
    writePngs({ "a.png": make24ByteHeaderPng() })(join(root, sessionId));
    const lateSleep = (ms) => new Promise((r) => setTimeout(r, ms + 300)); // always fires 300ms late
    const r = await pollForSettledPngs(root, sessionId, { timeoutMs: 250, intervalMs: 100, sleep: lateSleep });
    assert.equal(r.polls, 1, "the late wake-up lands past the deadline, so no second poll starts");
    assert.ok(r.lastPollStartMs <= r.deadlineMs);
    assert.match(r.unsettled[0]?.reason ?? "", /did not settle/);
  });

  test("listSessionEntries counts the truncation probe as a read entry", async () => {
    const { listSessionEntries } = await importDist("mcp/image-harvest.js");
    const dir = tmp("pp-img-list-");
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.txt`), "");
    const over = listSessionEntries(dir, 3);
    assert.deepEqual([over.scanned, over.read, over.truncated], [3, 4, true]);
    const exact = listSessionEntries(dir, 5);
    assert.deepEqual([exact.scanned, exact.read, exact.truncated], [5, 5, false]);
  });

  test("distinct-object bound holds when every open FAILS verification with a fresh identity (identity recorded right after fstat)", async () => {
    const { pollForSettledPngs } = await importDist("mcp/image-harvest.js");
    const root = tmp("pp-img-root-");
    const sessionId = newSessionId();
    const dir = join(root, sessionId);
    const p = join(dir, "a.png");
    writePngs({ "a.png": makeSolidPng(2, 2) })(dir);
    let created = 1;
    const r = await pollForSettledPngs(root, sessionId, {
      timeoutMs: 60_000,
      intervalMs: 1,
      fileHooks: {
        // The opened object vanishes between the first check and realpath: a
        // NON-terminal "verification failed" — the path the reviewer showed
        // could open unboundedly many distinct objects under one name.
        afterFirstCheck: (path) => renameSync(path, `${path}.gone-${created}`),
      },
      sleep: async () => {
        writeFileSync(p, makeSolidPng(2, 2)); // a fresh object (new identity) under the same name for the next poll
        created += 1;
      },
    });
    assert.equal(r.kind, "ok");
    assert.match(r.rejected.find((x) => x.name === "a.png")?.reason ?? "", /replaced by a different file while polling/);
    assert.ok(r.opens <= 2, `at most two distinct objects opened under one name (opened ${r.opens})`);
  });

  test("distinct-file cap counts identities: a chosen name replaced by a different file between polls is refused", async () => {
    const { pollForSettledPngs } = await importDist("mcp/image-harvest.js");
    const root = tmp("pp-img-root-");
    const sessionId = newSessionId();
    const p = join(root, sessionId, "a.png");
    writePngs({ "a.png": make24ByteHeaderPng() })(join(root, sessionId)); // never settles, so it is re-opened every poll
    setTimeout(() => { rmSync(p); writeFileSync(p, make24ByteHeaderPng()); }, 100); // expires before poll 2 (timer order)
    const r = await pollForSettledPngs(root, sessionId, { timeoutMs: 60_000, intervalMs: 200 });
    assert.equal(r.kind, "ok");
    assert.match(r.rejected.find((x) => x.name === "a.png")?.reason ?? "", /replaced by a different file while polling/);
    assert.ok(r.opens <= 3, `the replacement was refused at once instead of being polled (${r.opens} opens)`);
  });

  test("distinct-image cap holds across polls: a PNG appearing later (sorting first) is never opened beyond the first 20", async () => {
    const { pollForSettledPngs } = await importDist("mcp/image-harvest.js");
    const root = tmp("pp-img-root-");
    const sessionId = newSessionId();
    const dir = join(root, sessionId);
    const files = {};
    for (let i = 0; i < 20; i++) files[`p${String(i).padStart(2, "0")}.png`] = make24ByteHeaderPng();
    writePngs(files)(dir);
    setTimeout(() => writeFileSync(join(dir, "a-late.png"), makeSolidPng(2, 2)), 250);
    const r = await pollForSettledPngs(root, sessionId, { timeoutMs: 60_000, intervalMs: 200 }); // the 250ms timer expires before poll 3 (timer order); the open budget ends polling at poll 9
    assert.equal(r.kind, "ok");
    assert.ok(r.overCap.includes("a-late.png"), `late PNG must be over the distinct cap: ${JSON.stringify(r.overCap)}`);
    assert.ok(!r.settled.some((s) => s.name === "a-late.png") && !r.unsettled.some((u) => u.name === "a-late.png"), "never tracked or opened");
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
 *
 * Round 3:
 *   session basename binding only               -> resolution must land on <root>/<sessionId> itself
 *   candidate re-lstat after realpath only      -> the candidate is re-checked after realpath
 *   both of the above                           -> + identity-preserving swap (rename + link) refused
 *   acceptPng decode gate skipped               -> acceptPng palette; end-to-end out-of-range palette
 *   unknown critical chunks allowed             -> unknown critical chunks / oversized palettes
 *   palette size vs bit depth (always 2**8)     -> unknown critical chunks / oversized palettes
 *
 * After round 3 (output binding):
 *   output_dir identity re-checked at write     -> output_dir replaced by a different PLAIN directory; end-to-end replaced during turn
 *   written path bound to the created fd        -> destination replaced after the write
 *   only our own file removed on failure        -> destination replaced after the write (replacement survives)
 *   (re-run on the new code: collision cap, output_dir link refusal, assertOutputDirIntact lstat, verifyWrittenPath realpath)
 *
 * After round 4 (verification ordering, no pathname deletion):
 *   file identity re-checked after realpath     -> destination swapped DURING verification
 *   path-based unlink reintroduced on failure   -> replaced after the write; swapped during verification; swapped before cleanup
 *   fd truncation of our own bytes removed      -> replaced after the write; swapped before cleanup
 *   (re-run: output_dir identity, written-path fd binding, assertOutputDirIntact lstat, verifyWrittenPath realpath)
 *
 * After round 5 (resolution first, identity last; verify before first byte):
 *   source path re-checked against the fd last  -> replacement present for the open and restored before realpath
 *   output_dir identity as the last write check -> output_dir swapped after all resolution
 *   created file verified before any byte       -> parent swapped for a junction right before the create
 *   old strict "no trailing zlib bytes" restored -> final-IDAT padding accepted and copied byte-for-byte
 *   file identity re-check after realpath        -> destination swapped DURING verification
 *   (re-run red on the new code: fd dev/ino, post-open lstat symlink, fd-only read, session dir identity at open,
 *    output_dir identity, written-path fd binding, verifyWrittenPath realpath, no pathname deletion, fd truncation)
 *
 * Lead review (ancillary chunks, settle binding, cumulative budgets) + round-6 Medium:
 *   ancillary checks not applied                -> unvalidated-ancillary refusal; ancillary rule fixtures; tRNS-on-RGBA e2e
 *   tRNS allowed for colour types 4/6           -> ancillary rule fixtures; tRNS-on-RGBA e2e
 *   ancillary multiplicity unchecked            -> ancillary rule fixtures (duplicate gAMA)
 *   unvalidated ancillary types accepted        -> unvalidated-ancillary refusal; ancillary rule fixtures
 *   final open not bound to settle observation  -> settled red PNG replaced by a complete green PNG
 *   post-read fd check not called               -> source file modified while it is being read
 *   per-poll (not cumulative) entry budget      -> cumulative entry budget
 *   open budget removed                         -> cumulative open budget
 *   distinct-image cap reset per poll           -> image cap; distinct-image cap across polls
 *   truncation failure swallowed                -> failed truncation reported as such
 *   (re-run red: stale refusal, decode gate, unknown critical chunks)
 *
 * Operator decision — private staging + single exclusive hand-off:
 *   staged file not verified inside staging     -> relocation during staging write (direct + end to end)
 *   staged bytes not read back / compared       -> staged bytes altered in place
 *   hand-off replaced by a direct write         -> 29 tests red (identity binding to the staged inode everywhere)
 *   copy-mode no-entry pre-check removed        -> pre-existing file/symlink/DANGLING symlink (Windows exclusive copy follows it)
 *   hand-off identity vs staged inode removed   -> handed-off file replaced; cleanup-swap
 *   hand-off byte comparison removed            -> handed-off file altered in place (link and copy)
 *   link-mode neutralisation removed            -> replaced; cleanup-swap; parent junction swap; forced truncation failure
 *   staging identity / linked parent / replaced-dir removal / end-of-call removal -> the staging tests
 *   truncation failure swallowed (re-run)       -> failed truncation reported as such
 *
 * Authorized round A findings:
 *   PLTE after bKGD/tRNS allowed                -> ancillary rule fixtures
 *   eXIf after IDAT allowed                     -> ancillary rule fixtures; eXIf-after-IDAT e2e
 *   chosen name not bound to its first identity -> same-name replacement refused (the mutated run also hit the file timeout)
 *   copy fallback reintroduced on EXDEV         -> fail closed (no copy fallback, nothing reaches output_dir)
 *   cleanup failure left status ok              -> staging cleanup failure turns ok into partial
 *   (re-run red on the link-only code: direct write instead of link -> 30 tests; staged-inode identity; fd neutralisation)
 *
 * Authorized round B findings:
 *   iCCP/zTXt accepted (unvalidated payload)    -> ancillary rule fixtures; iCCP e2e never copied
 *   compressed iTXt accepted                    -> ancillary rule fixtures
 *   eXIf TIFF header unchecked                  -> ancillary rule fixtures
 *   allocated staging dir not removed on failure -> failure after allocation (removed / remains)
 *   un-removable dir reported as removed        -> "could NOT be removed ... it remains"
 *   (re-run red: tRNS colour-type rule, unvalidated ancillary types)
 *
 * Authorized round C findings:
 *   cleanup unlinks a replaced staged path      -> replaced at cleanup time is left and reported
 *   recursive deletion of staging reintroduced  -> a file this call did not stage is never deleted
 *   staged files not recorded                   -> cleanup after a failed hand-off (+13 e2e tests turn partial)
 *   keyword printable / space rules removed     -> tEXt keyword control byte / leading space
 *   tEXt NUL, iTXt UTF-8 (text, translated kw), language-tag charset removed -> the matching counterexamples
 *   eXIf accepted again                          -> eXIf refused (rule fixture + e2e)
 *   tIME day <= 31 instead of the real calendar -> 2026-02-29 refused
 *   hard poll cap removed                        -> 30-poll cap
 *   poll allowed to start after the deadline     -> no poll starts after the deadline
 *   truncation probe not counted / no room left  -> probe counted; cumulative entry budget exactly 1000
 *   deadline not re-checked after the sleep      -> a late-firing sleep does not start another poll (found under
 *                                                   full-suite load, now deterministic via the sleep seam)
 *   NOTE: the pre-sleep "next poll would start after the deadline" check now stays GREEN when removed — the
 *   post-sleep check subsumes it for the invariant; it only avoids a useless sleep.
 *
 * Operator decision "Simplify" (supersedes the per-chunk ancillary rules and the
 * end-of-call staging cleanup listed above, which were REMOVED from the code):
 *   any ancillary chunk accepted again          -> 4 tests (all counterexamples, e2e, structure)
 *   allocation failure deletes its directory    -> retained and named
 *   call deletes its own staging directory      -> retained and reported; later-call sweep
 *   stale dirs not swept at call start          -> later call sweeps an earlier call's directory
 *   sweep ignores staleness                     -> fresh directory not swept
 *   sweep does not re-check a moved file / dir  -> replaced-after-observation file / directory left in place
 *   sweep does not skip links / unexpected types -> links and unexpected entries skipped
 *   identity of rejected opens not counted / not recorded right after fstat -> repeated failing opens stay bounded
 *
 * "Simplify" round 1 findings:
 *   staging parent not re-checked before moving a dir -> parent swapped for a junction mid-sweep
 *   parent + moved dir not re-checked before file ops  -> moved dir swapped for a junction to a hard link of the same file
 *   listing reads max+1 / dir at the bound swept        -> listings read at most 200; a dir reaching 200 is skipped
 *   (re-run red: post-move file / directory re-check, link skip)
 *   NOTE (subsumed, disclosed): stopping the WHOLE sweep after an abort is defence in depth — every later
 *   rename/unlink/rmdir re-checks the same bound directories, so removing the early stop alone stays green.
 *   The individual bound() calls before unlink and rmdir are covered only collectively (Z2): there is no seam
 *   between a rename and the following unlink to stage a swap at exactly that point.
 *   NOT FALSIFIABLE (disclosed): re-validating the RE-ENCODED output with acceptPng — pngjs always emits a valid PNG, so
 *   no fixture can make that defence-in-depth check fire without replacing the encoder.
 *   NOTE: removing only the link/type clause of the output_dir check stays GREEN — it is subsumed, not missing:
 *   realpath equality runs first and catches a link, and a link can never carry the directory's pinned dev+ino
 *   (that identity check, when removed, turns three tests red).
 */
