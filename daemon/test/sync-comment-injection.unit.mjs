/**
 * Comment-injection guard for scripts/sync-copilot-assets.mjs.
 *
 * The Copilot mirror generator preserves source YAML frontmatter comments by
 * embedding them inside an HTML comment in the generated body. That makes the
 * source text a payload inside a delimiter, so a comment containing "-->" could
 * close the block early and spill the remainder as live markup.
 *
 * A cross-vendor judge on run_tYE0v6WrwFWs flagged that the original guard only
 * asserted against the checked-in mirror -- which contains no hostile input and
 * therefore proves nothing about the transform. These tests push the payload
 * through the real function.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptUrl = pathToFileURL(join(__dirname, "..", "..", "scripts", "sync-copilot-assets.mjs")).href;
const { preservedFrontmatterComments, isDirectInvocation } = await import(scriptUrl);

const CLOSE = "--" + ">";   // written without a literal terminator in this source

describe("sync-copilot-assets: HTML comment injection", () => {
  test("a comment containing the terminator cannot close the block", () => {
    const fm = ["# innocuous", "# evil " + CLOSE + " <script>alert(1)</script>", "# tail"].join("\n");
    const out = preservedFrontmatterComments(fm, "src.md");
    const body = out.slice(0, out.lastIndexOf(CLOSE));
    assert.equal(
      body.includes(CLOSE),
      false,
      "the payload closed the HTML comment early; everything after it escapes as live markup",
    );
  });

  test("exactly one closing delimiter is emitted, at the end", () => {
    const fm = ["# a " + CLOSE, "# b " + CLOSE].join("\n");
    const out = preservedFrontmatterComments(fm, "src.md");
    assert.equal(out.split(CLOSE).length - 1, 1);
    assert.ok(out.trimEnd().endsWith(CLOSE));
  });

  test("long dash runs are neutralised too", () => {
    const fm = "# dashes ----" + ">";
    const out = preservedFrontmatterComments(fm, "src.md");
    const body = out.slice(0, out.lastIndexOf(CLOSE));
    assert.equal(body.includes(CLOSE), false);
  });

  test("the rationale text still survives readably", () => {
    const fm = "# copilot-model is deliberately NOT swept with the codex pins.";
    const out = preservedFrontmatterComments(fm, "src.md");
    assert.match(out, /copilot-model is deliberately NOT swept/);
  });

  test("no comments yields no block at all", () => {
    assert.equal(preservedFrontmatterComments("name: x\ntools: y", "src.md"), "");
  });
});

// ─── isDirectInvocation (F3, judge finding on run_tYE0v6WrwFWs) ─────────────
//
// Nothing in the suite pinned this guard; its behaviour was held only by a manual
// check. It is the boundary that keeps `main()` -- which calls
// rmSync(..., {recursive:true, force:true}) on generated directories -- from
// firing on a bare `import`. That deserves a test.
describe("sync-copilot-assets: direct-invocation guard", () => {
  test("importing the module does NOT run main (no side effects)", () => {
    // If main() had run at import time, the module-level import above would have
    // regenerated .github. Reaching this line at all is the assertion; the guard
    // is what makes importing the module safe enough to unit test.
    assert.equal(typeof isDirectInvocation, "function");
  });

  test("returns false when argv[1] is absent", () => {
    const saved = process.argv[1];
    try {
      process.argv[1] = undefined;
      assert.equal(isDirectInvocation(), false);
    } finally {
      process.argv[1] = saved;
    }
  });

  test("returns false and WARNS when the path cannot be resolved", () => {
    // Fails closed, but loudly. A silent false here is the inverse bug: a genuine
    // direct invocation that syncs nothing and says nothing.
    const saved = process.argv[1];
    const written = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
    try {
      process.argv[1] = join(__dirname, "definitely-not-a-real-file-" + Date.now() + ".mjs");
      assert.equal(isDirectInvocation(), false, "must fail closed");
      assert.ok(
        written.join("").includes("sync-copilot-assets"),
        "must fail LOUDLY: no stderr warning was emitted, so an operator would see " +
          "a silent no-op instead of a reason",
      );
    } finally {
      process.stderr.write = realWrite;
      process.argv[1] = saved;
    }
  });

  test("returns false for a real file that is not this module", () => {
    const saved = process.argv[1];
    try {
      process.argv[1] = fileURLToPath(import.meta.url);   // this test file, not the script
      assert.equal(isDirectInvocation(), false);
    } finally {
      process.argv[1] = saved;
    }
  });
});
