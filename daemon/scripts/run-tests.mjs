#!/usr/bin/env node
// Cross-platform test-chain wrapper.
//
// Scrubs the two ledger-location override variables (PP_DB_PATH, PP_HOME --
// see src/util/paths.ts) out of THIS process's env before running the
// build + full test chain. Every subsequent step (the `node --test` per-file
// subprocesses, and any `pp-daemon mcp` child those files spawn) inherits
// process.env by default, so scrubbing it here closes the whole class of
// leak where an operator's exported PP_DB_PATH survives a test's
// `{ ...process.env, PP_HOME: tempDir }` override (PP_DB_PATH wins over
// PP_HOME in paths.ts) and the test silently writes into the operator's
// REAL ~/.pair-programmer/state.db.
//
// pretest/posttest (scripts/hermetic-guard.mjs snapshot/verify) run as their
// own separate `npm` lifecycle invocations OUTSIDE this wrapper and
// intentionally still resolve the operator's real ledger path -- that's the
// point of the guard (it watches the real ledger for test-attributable
// writes that leaked past every other safeguard, including this one).
//
// This does not replace per-test isolation (each test still sets its own
// explicit temp PP_HOME, and daemon-spawning tests use
// test/fixtures/isolated-env.mjs for an explicit temp PP_DB_PATH too) --
// it is defense-in-depth against the far larger set of unit tests that only
// set process.env.PP_HOME on their own process and rely on PP_DB_PATH being
// absent.

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execaSync } from "execa";

const __dirname = dirname(fileURLToPath(import.meta.url));
const daemonRoot = join(__dirname, "..");

delete process.env.PP_DB_PATH;
delete process.env.PP_HOME;

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  execaSync(cmd, args, { cwd: daemonRoot, stdio: "inherit", env: process.env, ...opts });
}

// Resolve the unit-test file list ourselves (no shell glob dependency --
// this script is invoked directly via `node`, not through a shell that
// would expand `test/*.unit.mjs`).
const unitFiles = readdirSync(join(daemonRoot, "test"))
  .filter((f) => f.endsWith(".unit.mjs"))
  .sort()
  .map((f) => join("test", f));

run("npm", ["run", "build"]);
run(process.execPath, ["--test", "--test-timeout=180000", ...unitFiles]);
run(process.execPath, [join("test", "smoke.mjs")]);
run(process.execPath, [join("test", "artifact-validators.smoke.mjs")]);
run(process.execPath, [join("test", "eights-integration.smoke.mjs")]);
