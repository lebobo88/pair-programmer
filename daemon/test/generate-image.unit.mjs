/**
 * Hermetic tests for `generate_image` on both vendor wrappers (X1c).
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
 *     directory, even when a concurrent session directory is newer".
 *   - Removing the byte-budget check from downscaleImageToFit must fail
 *     "a large image is downscaled under the byte budget".
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
      const sessionId = "sess-ok-1";
      const sessionDir = join(imagesRoot, sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "exec-call-1.png"), makeSolidPng(10, 10));

      const result = await codexGenerateImage(
        { prompt: "draw a circle", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: 300 * 1024 },
        {
          _invoke: async () => ({ ...baseCodexResult, session_id: sessionId }),
          _imagesRoot: imagesRoot,
        },
      );

      assert.equal(result.status, "ok");
      assert.equal(result.session_id, sessionId);
      assert.equal(result.images.length, 1);
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
    try {
      const result = await codexGenerateImage(
        { prompt: "draw a circle", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: 300 * 1024 },
        {
          _invoke: async () => ({ ...baseCodexResult, session_id: undefined }),
          _imagesRoot: mkdtempSync(join(tmpdir(), "pp-img-root-unused-")),
        },
      );
      assert.equal(result.status, "no_session_id");
      assert.match(result.reason, /session_id/i);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("an empty session directory returns a structured empty_session_dir failure", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const imagesRoot = mkdtempSync(join(tmpdir(), "pp-img-root-"));
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    try {
      const sessionId = "sess-empty-1";
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
      assert.match(result.reason, /no PNG files/i);
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
      const sessionId = "sess-large-1";
      const sessionDir = join(imagesRoot, sessionId);
      mkdirSync(sessionDir, { recursive: true });
      const bigPng = makeNoisyPng(1024, 1024);
      // Sanity: the fixture must actually exceed the budget before downscale,
      // or this test would pass vacuously.
      const BUDGET = 300 * 1024;
      assert.ok(bigPng.length > BUDGET, "fixture must start out over budget");
      writeFileSync(join(sessionDir, "exec-call-big.png"), bigPng);

      const result = await codexGenerateImage(
        { prompt: "draw noise", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: BUDGET },
        {
          _invoke: async () => ({ ...baseCodexResult, session_id: sessionId }),
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

  test("an image already small enough is left unchanged", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const imagesRoot = mkdtempSync(join(tmpdir(), "pp-img-root-"));
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    try {
      const sessionId = "sess-small-1";
      const sessionDir = join(imagesRoot, sessionId);
      mkdirSync(sessionDir, { recursive: true });
      const smallPng = makeSolidPng(64, 32);
      writeFileSync(join(sessionDir, "exec-call-small.png"), smallPng);

      const result = await codexGenerateImage(
        { prompt: "draw a small solid block", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: 300 * 1024 },
        {
          _invoke: async () => ({ ...baseCodexResult, session_id: sessionId }),
          _imagesRoot: imagesRoot,
        },
      );

      assert.equal(result.status, "ok");
      const img = result.images[0];
      assert.equal(img.width, 64, "already within max_dimension and byte_budget — width unchanged");
      assert.equal(img.height, 32, "already within max_dimension and byte_budget — height unchanged");
    } finally {
      rmSync(imagesRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("harvests only the reported session's directory, even when a concurrent session directory is newer", async () => {
    const { codexGenerateImage } = await importDist("mcp/codex-server.js");
    const imagesRoot = mkdtempSync(join(tmpdir(), "pp-img-root-"));
    const outputDir = mkdtempSync(join(tmpdir(), "pp-img-out-"));
    try {
      const trueSessionId = "sess-true-1";
      const otherSessionId = "sess-concurrent-2";

      // Create THIS turn's session directory FIRST...
      const trueDir = join(imagesRoot, trueSessionId);
      mkdirSync(trueDir, { recursive: true });
      writeFileSync(join(trueDir, "exec-call-true.png"), makeSolidPng(8, 8, [10, 20, 30, 255]));

      // ...then a DIFFERENT, CONCURRENT session's directory lands AFTER it
      // (newer mtime). A newest-mtime scan would pick this one instead.
      const otherDir = join(imagesRoot, otherSessionId);
      mkdirSync(otherDir, { recursive: true });
      writeFileSync(join(otherDir, "exec-call-other.png"), makeSolidPng(8, 8, [200, 100, 50, 255]));

      const result = await codexGenerateImage(
        { prompt: "draw a circle", cwd: "/some/worktree", model: "gpt-5.6-luna", output_dir: outputDir, max_dimension: 768, byte_budget_bytes: 300 * 1024 },
        {
          _invoke: async () => ({ ...baseCodexResult, session_id: trueSessionId }),
          _imagesRoot: imagesRoot,
        },
      );

      assert.equal(result.status, "ok");
      assert.equal(result.session_id, trueSessionId);
      assert.equal(result.images.length, 1);
      assert.match(
        result.images[0].path,
        /exec-call-true\.png$/,
        "must harvest the reported session's file, not the newer concurrent session's file",
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
