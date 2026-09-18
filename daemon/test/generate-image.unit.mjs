/**
 * Hermetic tests for `generate_image` on both vendor wrappers (X1c), hardened
 * against the gpt-5.6-terra cross-vendor critique (path handling, per-turn
 * harvest freshness, byte-budget/format-preservation, and robustness).
 *
 * ANTI-STALL TEST RULE: imports only from dist/ and pngjs; no test spawns a
 * real CLI. The codex exec turn is replaced via the `_invoke` DI seam (same
 * pattern as codexCritique's test seam), and the harvest directory is
 * replaced via the `_imagesRoot` DI seam so no test touches the real
 * `~/.codex/generated_images`.
 *
 * Mutation proofs (see bottom of file for the manual verification log):
 *   - Scanning `~/.codex/generated_images` by newest mtime instead of the
 *     reported session_id must fail "harvests only the reported session's
 *     directory, even when a concurrent session directory is newer (mtimes set)".
 *   - Removing the byte-budget check from downscaleImageToFit must fail
 *     "a large image is downscaled under the byte budget".
 *   - Removing session-id validation must fail "a traversal-shaped session_id
 *     is rejected instead of used as a path segment".
 *   - Allowing resumption (dropping fresh_session) must fail "a resumed
 *     session's stale pre-existing file is never returned as a new image".
 *   - Returning ok when over budget at the floor must fail "an image that
 *     still exceeds the byte budget at the 256px floor is never reported ok".
 *   - Re-encoding an already-fitting image must fail "a non-RGBA PNG that
 *     already fits is preserved byte-for-byte".
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  statSync,
} from "node:fs";
import zlib from "node:zlib";
import { PNG } from "pngjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

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
  // Deterministic PRNG (no external dependency, no crypto import needed).
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

/** Standard CRC32 (IEEE 802.3), used to hand-assemble a minimal grayscale PNG below. */
function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
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

/**
 * Hand-assemble a real, valid 8-bit GRAYSCALE (colorType 0) PNG — pngjs's
 * writer only ever emits 8-bit RGBA (colorType 6), so this is the only way
 * to fixture a genuinely non-RGBA PNG for the format-preservation test.
 */
function makeGrayscalePng(width, height, value = 128) {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 0; // color type: grayscale
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = pngChunk("IHDR", ihdrData);

  const raw = Buffer.alloc(height * (1 + width));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x++) raw[rowStart + 1 + x] = value;
  }
  const idat = pngChunk("IDAT", zlib.deflateSync(raw));
  const iend = pngChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([SIGNATURE, ihdr, idat, iend]);
}

const baseCodexResult = {
  text: "",
  tokens_in: 10,
  tokens_out: 20,
  cost_usd: 0.001,
  model: "gpt-5.6-luna",
  wall_ms: 5,
  exit_code: 0,
};

describe("pp_codex.generate_image", () => {
  test("successful harvest from the session directory", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const imagesRoot = mkdtempSync(join(tmpdir(), "pp-img-root-"));
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    try {
      const sessionId = "aaaa1111-0000-4000-8000-000000000001";
      const sessionDir = join(imagesRoot, sessionId);

      const result = await codexGenerateImage(
        { prompt: "draw a circle", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: 300 * 1024 },
        {
          // The CLI turn itself is what writes the image, so the fixture is
          // created inside `_invoke` — writing it BEFORE invoking would make
          // it indistinguishable from stale pre-existing carry-over.
          _invoke: async () => {
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "exec-call-1.png"), makeSolidPng(10, 10));
            return { ...baseCodexResult, session_id: sessionId };
          },
          _imagesRoot: imagesRoot,
        },
      );

      assert.equal(result.status, "ok");
      assert.equal(result.session_id, sessionId);
      assert.equal(result.images.length, 1);
      assert.equal(result.over_budget.length, 0);
      assert.equal(result.failures.length, 0);
      const img = result.images[0];
      assert.equal(img.generator, "codex");
      assert.equal(img.model, "gpt-5.6-luna");
      assert.equal(img.prompt, "draw a circle");
      assert.ok(img.path.startsWith(outputDir), "harvested file lands in the caller's output_dir");
      const onDisk = readFileSync(img.path);
      assert.equal(onDisk.length, img.bytes, "reported byte size matches the file actually written");
      assert.equal(img.width, 10);
      assert.equal(img.height, 10);
    } finally {
      rmSync(imagesRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("a missing session id returns a structured no_session_id failure, never a guessed directory", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    const imagesRootUnused = mkdtempSync(join(tmpdir(), "pp-img-root-unused-"));
    try {
      const result = await codexGenerateImage(
        { prompt: "draw a circle", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: 300 * 1024 },
        {
          _invoke: async () => ({ ...baseCodexResult, session_id: undefined }),
          _imagesRoot: imagesRootUnused,
        },
      );
      assert.equal(result.status, "no_session_id");
      assert.match(result.reason, /session_id/i);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
      rmSync(imagesRootUnused, { recursive: true, force: true });
    }
  });

  test("a traversal-shaped session_id is rejected instead of used as a path segment", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const imagesRoot = mkdtempSync(join(tmpdir(), "pp-img-root-"));
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    try {
      // A sibling directory outside the "session id" namespace, simulating
      // another session's private images that traversal would otherwise reach.
      const otherSessionDir = join(imagesRoot, "other-session");
      mkdirSync(otherSessionDir, { recursive: true });
      writeFileSync(join(otherSessionDir, "secret.png"), makeSolidPng(4, 4));

      const result = await codexGenerateImage(
        { prompt: "draw a circle", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: 300 * 1024 },
        {
          _invoke: async () => ({ ...baseCodexResult, session_id: "../other-session" }),
          _imagesRoot: imagesRoot,
        },
      );

      assert.equal(result.status, "invalid_session_id");
      assert.match(result.reason, /session_id|pattern/i);
      // Nothing should have been copied out of the sibling directory.
      assert.deepEqual(readdirSync(outputDir), []);
    } finally {
      rmSync(imagesRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("a symlinked .png is not harvested", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const imagesRoot = mkdtempSync(join(tmpdir(), "pp-img-root-"));
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    try {
      const sessionId = "bbbb2222-0000-4000-8000-000000000002";
      const sessionDir = join(imagesRoot, sessionId);
      const outsideTarget = join(imagesRoot, "outside-target.png");
      writeFileSync(outsideTarget, makeSolidPng(4, 4));

      const result = await codexGenerateImage(
        { prompt: "draw a circle", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: 300 * 1024 },
        {
          _invoke: async () => {
            mkdirSync(sessionDir, { recursive: true });
            symlinkSync(outsideTarget, join(sessionDir, "exec-call-link.png"), "file");
            // A genuine regular file too, so the call still succeeds overall.
            writeFileSync(join(sessionDir, "exec-call-real.png"), makeSolidPng(4, 4));
            return { ...baseCodexResult, session_id: sessionId };
          },
          _imagesRoot: imagesRoot,
        },
      );

      assert.equal(result.status, "ok");
      assert.equal(result.images.length, 1, "only the real regular file is harvested");
      assert.match(result.images[0].path, /exec-call-real\.png$/);
    } finally {
      rmSync(imagesRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("a directory named x.png is not harvested", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const imagesRoot = mkdtempSync(join(tmpdir(), "pp-img-root-"));
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    try {
      const sessionId = "cccc3333-0000-4000-8000-000000000003";
      const sessionDir = join(imagesRoot, sessionId);

      const result = await codexGenerateImage(
        { prompt: "draw a circle", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: 300 * 1024 },
        {
          _invoke: async () => {
            mkdirSync(join(sessionDir, "x.png"), { recursive: true }); // a DIRECTORY, not a file
            writeFileSync(join(sessionDir, "exec-call-real.png"), makeSolidPng(4, 4));
            return { ...baseCodexResult, session_id: sessionId };
          },
          _imagesRoot: imagesRoot,
        },
      );

      assert.equal(result.status, "ok");
      assert.equal(result.images.length, 1);
      assert.match(result.images[0].path, /exec-call-real\.png$/);
    } finally {
      rmSync(imagesRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("output containment: a pre-existing symlink at the destination name is never followed or overwritten", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const imagesRoot = mkdtempSync(join(tmpdir(), "pp-img-root-"));
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    const escapeTarget = mkdtempSync(join(tmpdir(), "pp-img-escape-"));
    try {
      const sessionId = "dddd4444-0000-4000-8000-000000000004";
      const sessionDir = join(imagesRoot, sessionId);

      const escapeFile = join(escapeTarget, "canary.txt");
      writeFileSync(escapeFile, "do-not-touch");
      // A symlink already sitting at the exact destination name, pointing
      // OUTSIDE output_dir.
      symlinkSync(escapeFile, join(outputDir, "exec-call-1.png"), "file");

      const result = await codexGenerateImage(
        { prompt: "draw a circle", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: 300 * 1024 },
        {
          _invoke: async () => {
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "exec-call-1.png"), makeSolidPng(4, 4));
            return { ...baseCodexResult, session_id: sessionId };
          },
          _imagesRoot: imagesRoot,
        },
      );

      assert.equal(result.status, "ok");
      assert.equal(result.images.length, 1);
      const img = result.images[0];
      assert.ok(img.path.startsWith(outputDir), "final path stays inside output_dir");
      assert.notEqual(img.path, join(outputDir, "exec-call-1.png"), "must not overwrite the existing symlink's name");
      assert.equal(readFileSync(escapeFile, "utf8"), "do-not-touch", "the symlink target outside output_dir was never written to");
    } finally {
      rmSync(imagesRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
      rmSync(escapeTarget, { recursive: true, force: true });
    }
  });

  test("an empty session directory returns a structured empty_session_dir failure", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const imagesRoot = mkdtempSync(join(tmpdir(), "pp-img-root-"));
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    try {
      const sessionId = "eeee5555-0000-4000-8000-000000000005";
      mkdirSync(join(imagesRoot, sessionId), { recursive: true }); // exists, but no PNGs written

      const result = await codexGenerateImage(
        { prompt: "draw a circle", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: 300 * 1024 },
        {
          _invoke: async () => ({ ...baseCodexResult, session_id: sessionId }),
          _imagesRoot: imagesRoot,
        },
      );
      assert.equal(result.status, "empty_session_dir");
      assert.equal(result.session_id, sessionId);
      assert.match(result.reason, /no PNG files|polled/i);
    } finally {
      rmSync(imagesRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("a delayed/partial file arriving shortly after the CLI returns is still harvested (bounded poll)", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const imagesRoot = mkdtempSync(join(tmpdir(), "pp-img-root-"));
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    try {
      const sessionId = "ffff6666-0000-4000-8000-000000000006";
      const sessionDir = join(imagesRoot, sessionId);

      const result = await codexGenerateImage(
        { prompt: "draw a circle", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: 300 * 1024 },
        {
          _invoke: async () => {
            // Simulate the CLI process exiting BEFORE its own image-write
            // flush is visible: the directory/file appear ~300ms later,
            // well inside the tool's bounded poll window.
            setTimeout(() => {
              mkdirSync(sessionDir, { recursive: true });
              writeFileSync(join(sessionDir, "exec-call-delayed.png"), makeSolidPng(4, 4));
            }, 300);
            return { ...baseCodexResult, session_id: sessionId };
          },
          _imagesRoot: imagesRoot,
        },
      );

      assert.equal(result.status, "ok");
      assert.equal(result.images.length, 1);
      assert.match(result.images[0].path, /exec-call-delayed\.png$/);
    } finally {
      rmSync(imagesRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("a resumed session's stale pre-existing file is never returned as a new image", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const imagesRoot = mkdtempSync(join(tmpdir(), "pp-img-root-"));
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    try {
      // Simulate a codex CLI that (incorrectly) resumed a prior session and
      // re-reported its id: the directory already has an OLD image in it
      // before this call ever ran.
      const sessionId = "1234abcd-0000-4000-8000-0000000000ff";
      const sessionDir = join(imagesRoot, sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "exec-call-old.png"), makeSolidPng(4, 4, [1, 2, 3, 255]));

      const result = await codexGenerateImage(
        { prompt: "draw a circle", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: 300 * 1024 },
        {
          // No NEW file is written for this call — the CLI merely reported
          // the pre-existing stale session id.
          _invoke: async () => ({ ...baseCodexResult, session_id: sessionId }),
          _imagesRoot: imagesRoot,
        },
      );

      assert.equal(result.status, "empty_session_dir");
      assert.match(result.reason, /pre-date|stale/i);
    } finally {
      rmSync(imagesRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("a non-zero CLI result returns a structured cli_failure, never a stale-but-ok result", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const imagesRoot = mkdtempSync(join(tmpdir(), "pp-img-root-"));
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    try {
      const sessionId = "22223333-0000-4000-8000-000000000007";
      const sessionDir = join(imagesRoot, sessionId);
      mkdirSync(sessionDir, { recursive: true });
      // Even though a PNG happens to be sitting there (e.g. from a prior
      // partial attempt), a non-zero exit must never be reported as ok.
      writeFileSync(join(sessionDir, "exec-call-1.png"), makeSolidPng(4, 4));

      const result = await codexGenerateImage(
        { prompt: "draw a circle", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: 300 * 1024 },
        {
          _invoke: async () => ({ ...baseCodexResult, session_id: sessionId, exit_code: 1 }),
          _imagesRoot: imagesRoot,
        },
      );

      assert.equal(result.status, "cli_failure");
      assert.equal(result.exit_code, 1);
    } finally {
      rmSync(imagesRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("a large image is downscaled under the byte budget", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const imagesRoot = mkdtempSync(join(tmpdir(), "pp-img-root-"));
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    try {
      const sessionId = "33334444-0000-4000-8000-000000000008";
      const sessionDir = join(imagesRoot, sessionId);
      const bigPng = makeNoisyPng(1024, 1024);
      // Sanity: the fixture must actually exceed the budget before downscale,
      // or this test would pass vacuously.
      const BUDGET = 300 * 1024;
      assert.ok(bigPng.length > BUDGET, "fixture must start out over budget");

      const result = await codexGenerateImage(
        { prompt: "draw noise", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: BUDGET },
        {
          _invoke: async () => {
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "exec-call-big.png"), bigPng);
            return { ...baseCodexResult, session_id: sessionId };
          },
          _imagesRoot: imagesRoot,
        },
      );

      assert.equal(result.status, "ok");
      const img = result.images[0];
      assert.ok(img.bytes <= BUDGET, `downscaled image (${img.bytes}B) must fit the byte budget (${BUDGET}B)`);
      assert.ok(img.width < 1024 && img.height < 1024, "dimensions must have shrunk from the 1024x1024 original");
      assert.ok(Math.max(img.width, img.height) >= 256, "downscale never goes below the 256px floor");
    } finally {
      rmSync(imagesRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("an image that still exceeds the byte budget at the 256px floor is never reported ok", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const imagesRoot = mkdtempSync(join(tmpdir(), "pp-img-root-"));
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    try {
      const sessionId = "44445555-0000-4000-8000-000000000009";
      const sessionDir = join(imagesRoot, sessionId);
      const bigPng = makeNoisyPng(1024, 1024);
      // An unreasonably tiny budget that even the 256px floor cannot satisfy
      // for a high-entropy image.
      const IMPOSSIBLE_BUDGET = 200;

      const result = await codexGenerateImage(
        { prompt: "draw noise", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: IMPOSSIBLE_BUDGET },
        {
          _invoke: async () => {
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "exec-call-impossible.png"), bigPng);
            return { ...baseCodexResult, session_id: sessionId };
          },
          _imagesRoot: imagesRoot,
        },
      );

      assert.notEqual(result.status, "ok", "must not report ok when an image is over budget even at the floor");
      assert.equal(result.status, "partial");
      assert.equal(result.images.length, 0, "the over-budget image must not appear in the success list");
      assert.equal(result.over_budget.length, 1);
      assert.ok(result.over_budget[0].bytes > IMPOSSIBLE_BUDGET);
      assert.ok(Math.max(result.over_budget[0].width, result.over_budget[0].height) >= 256);
    } finally {
      rmSync(imagesRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("an image already small enough is left unchanged", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const imagesRoot = mkdtempSync(join(tmpdir(), "pp-img-root-"));
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    try {
      const sessionId = "55556666-0000-4000-8000-00000000000a";
      const sessionDir = join(imagesRoot, sessionId);
      const smallPng = makeSolidPng(64, 32);

      const result = await codexGenerateImage(
        { prompt: "draw a small solid block", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: 300 * 1024 },
        {
          _invoke: async () => {
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "exec-call-small.png"), smallPng);
            return { ...baseCodexResult, session_id: sessionId };
          },
          _imagesRoot: imagesRoot,
        },
      );

      assert.equal(result.status, "ok");
      const img = result.images[0];
      assert.equal(img.width, 64, "already within max_dimension and byte_budget — width unchanged");
      assert.equal(img.height, 32, "already within max_dimension and byte_budget — height unchanged");
      assert.deepEqual(readFileSync(img.path), smallPng, "already-fitting image is copied byte-for-byte, no re-encode");
    } finally {
      rmSync(imagesRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("a non-RGBA PNG that already fits is preserved byte-for-byte", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const imagesRoot = mkdtempSync(join(tmpdir(), "pp-img-root-"));
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    try {
      const sessionId = "66667777-0000-4000-8000-00000000000b";
      const sessionDir = join(imagesRoot, sessionId);
      const grayscalePng = makeGrayscalePng(32, 16, 200);

      const result = await codexGenerateImage(
        { prompt: "draw grayscale", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: 300 * 1024 },
        {
          _invoke: async () => {
            mkdirSync(sessionDir, { recursive: true });
            writeFileSync(join(sessionDir, "exec-call-gray.png"), grayscalePng);
            return { ...baseCodexResult, session_id: sessionId };
          },
          _imagesRoot: imagesRoot,
        },
      );

      assert.equal(result.status, "ok");
      const img = result.images[0];
      assert.equal(img.width, 32);
      assert.equal(img.height, 16);
      const onDisk = readFileSync(img.path);
      assert.deepEqual(onDisk, grayscalePng, "grayscale original preserved byte-for-byte — never decoded/re-encoded to RGBA");
    } finally {
      rmSync(imagesRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("harvests only the reported session's directory, even when a concurrent session directory is newer (mtimes set)", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const imagesRoot = mkdtempSync(join(tmpdir(), "pp-img-root-"));
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    try {
      const trueSessionId = "77778888-0000-4000-8000-00000000000c";
      const otherSessionId = "88889999-0000-4000-8000-00000000000d";
      const trueDir = join(imagesRoot, trueSessionId);

      // A DIFFERENT, CONCURRENT session's directory already exists before
      // this call, with a NEWER mtime than the one THIS call will create.
      const otherDir = join(imagesRoot, otherSessionId);
      mkdirSync(otherDir, { recursive: true });
      writeFileSync(join(otherDir, "exec-call-other.png"), makeSolidPng(8, 8, [200, 100, 50, 255]));
      const newer = new Date();
      utimesSync(otherDir, newer, newer);

      const result = await codexGenerateImage(
        { prompt: "draw a circle", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: 300 * 1024 },
        {
          _invoke: async () => {
            // THIS turn's session directory is created (older mtime, set
            // explicitly) AFTER the concurrent one already exists.
            mkdirSync(trueDir, { recursive: true });
            writeFileSync(join(trueDir, "exec-call-true.png"), makeSolidPng(8, 8, [10, 20, 30, 255]));
            const older = new Date(Date.now() - 60_000);
            utimesSync(trueDir, older, older);
            return { ...baseCodexResult, session_id: trueSessionId };
          },
          _imagesRoot: imagesRoot,
        },
      );

      // Explicitly SET (and assert) mtimes so this test genuinely proves a
      // session-id match, not an mtime scan that happens to agree with
      // creation order on this filesystem.
      const trueMtime = statSync(trueDir).mtimeMs;
      const otherMtime = statSync(otherDir).mtimeMs;
      assert.ok(otherMtime > trueMtime, "the concurrent (wrong) session directory must be strictly newer");

      assert.equal(result.status, "ok");
      assert.equal(result.session_id, trueSessionId);
      assert.equal(result.images.length, 1);
      assert.match(
        result.images[0].path,
        /exec-call-true\.png$/,
        "must harvest the reported (older) session's file, not the newer concurrent session's file",
      );
    } finally {
      rmSync(imagesRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
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
 * ─── Mutation-proof log (manual verification) ──────────────────────────────
 *
 * Each proof below was verified by temporarily reverting the named guard in
 * codex-server.ts, confirming the named test fails, then restoring the guard.
 *
 *   1. Drop `isValidSessionId` (let any session_id through) →
 *      "a traversal-shaped session_id is rejected instead of used as a path
 *      segment" fails (result.status becomes "empty_session_dir" instead of
 *      "invalid_session_id", or worse, reads the sibling directory).
 *   2. Set `fresh_session` to always false (allow resumption) →
 *      "a resumed session's stale pre-existing file is never returned as a
 *      new image" fails (the stale file is returned as if new).
 *   3. Drop the `buffer.length > args.byte_budget_bytes` over-budget check and
 *      always push into `images` →
 *      "an image that still exceeds the byte budget at the 256px floor is
 *      never reported ok" fails (status stays "ok", over_budget stays empty).
 *   4. Always decode+re-encode instead of the `fitsAsIs` verbatim-copy path →
 *      "a non-RGBA PNG that already fits is preserved byte-for-byte" fails
 *      (pngjs re-encodes grayscale input as 8-bit RGBA, producing a
 *      differently-sized, differently-typed PNG that fails the byte-for-byte
 *      deepEqual).
 *   5. Removing the byte-budget check from downscaleImageToFit (pre-existing
 *      proof, still valid) → "a large image is downscaled under the byte
 *      budget" fails.
 */
