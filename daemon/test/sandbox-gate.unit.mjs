/**
 * sandbox-gate.unit.mjs
 *
 * Unit tests for the server-side sandbox=danger-full-access deny gate
 * (audit §9.6) added to pp_codex generate (mcp/codex-server.ts).
 *
 * Tests:
 *   1. assertSandboxAllowed("danger-full-access") throws SandboxPolicyViolation
 *      when PP_ALLOW_DANGER is unset.
 *   2. assertSandboxAllowed("danger-full-access") throws when PP_ALLOW_DANGER=""
 *      (any value other than "1" must still block).
 *   3. assertSandboxAllowed("danger-full-access") does NOT throw when
 *      PP_ALLOW_DANGER=1.
 *   4. assertSandboxAllowed("workspace-write") never throws (allowed policy).
 *   5. assertSandboxAllowed("read-only") never throws (allowed policy).
 *   6. Thrown error names the policy ("danger-full-access") and escape hatch
 *      (PP_ALLOW_DANGER=1) in its message.
 *
 * Anti-stall contract:
 *   - Pure function test — no DB, no subprocess, no network.
 *   - Run: node test/sandbox-gate.unit.mjs
 */

import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");

// PP_HOME / DB isolation not needed — we only call a pure exported function.
// Suppress the eights audit check to avoid any accidental DB boot.
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const { assertSandboxAllowed } = await import(
  pathToFileURL(join(DIST, "mcp", "codex-server.js")).href
);

let passed = 0;
let failed = 0;

function it(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err.message}`);
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Run fn in an env snapshot where PP_ALLOW_DANGER has the given value (or is deleted). */
function withDangerEnv(value, fn) {
  const orig = process.env.PP_ALLOW_DANGER;
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, "PP_ALLOW_DANGER");
  if (value === undefined) {
    delete process.env.PP_ALLOW_DANGER;
  } else {
    process.env.PP_ALLOW_DANGER = value;
  }
  try {
    fn();
  } finally {
    if (hadKey && orig !== undefined) {
      process.env.PP_ALLOW_DANGER = orig;
    } else {
      delete process.env.PP_ALLOW_DANGER;
    }
  }
}

// ─── tests ───────────────────────────────────────────────────────────────────

it("danger-full-access blocked when PP_ALLOW_DANGER is unset", () => {
  withDangerEnv(undefined, () => {
    let threw = false;
    try {
      assertSandboxAllowed("danger-full-access");
    } catch (err) {
      threw = true;
      assert.equal(err.name, "SandboxPolicyViolation",
        `expected SandboxPolicyViolation, got ${err.name}`);
    }
    assert.ok(threw, "must have thrown");
  });
});

it("danger-full-access blocked when PP_ALLOW_DANGER='' (not '1')", () => {
  withDangerEnv("", () => {
    let threw = false;
    try {
      assertSandboxAllowed("danger-full-access");
    } catch (err) {
      threw = true;
      assert.equal(err.name, "SandboxPolicyViolation");
    }
    assert.ok(threw, "empty string must not count as '1'");
  });
});

it("danger-full-access allowed when PP_ALLOW_DANGER=1", () => {
  withDangerEnv("1", () => {
    // Must not throw.
    assertSandboxAllowed("danger-full-access");
  });
});

it("workspace-write never blocked regardless of PP_ALLOW_DANGER", () => {
  withDangerEnv(undefined, () => {
    assertSandboxAllowed("workspace-write");
  });
  withDangerEnv("1", () => {
    assertSandboxAllowed("workspace-write");
  });
});

it("read-only never blocked regardless of PP_ALLOW_DANGER", () => {
  withDangerEnv(undefined, () => {
    assertSandboxAllowed("read-only");
  });
});

it("error message names the policy and the PP_ALLOW_DANGER=1 escape hatch", () => {
  withDangerEnv(undefined, () => {
    let errMsg = "";
    try {
      assertSandboxAllowed("danger-full-access");
    } catch (err) {
      errMsg = err.message;
    }
    assert.ok(errMsg.includes("danger-full-access"),
      `message must name the policy 'danger-full-access'; got: ${errMsg}`);
    assert.ok(errMsg.includes("PP_ALLOW_DANGER=1"),
      `message must name the escape hatch PP_ALLOW_DANGER=1; got: ${errMsg}`);
  });
});

// ─── summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
