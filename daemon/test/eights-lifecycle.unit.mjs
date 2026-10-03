// L1B: eights-client / TheEights subprocess lifecycle.
//
// Verifies the four mechanisms documented in eights-client.ts's "Process
// lifecycle (L1B)" comment block and shutdown.ts's EIGHTS_SHUTDOWN_CAP_MS
// comment, against the l1a process inventory's two runtime paths that reach
// probe()/spawn a TheEights child:
//
//   (i)   short-lived caller (models the `pp-daemon hook` path's underlying
//         eights-client usage): a bare Node script does one fire-and-forget
//         write and returns from main. Must exit on its own within ~10s, and
//         the fixture it talked to must actually be dead afterward — not
//         merely orphaned-but-unref'd.
//   (ii)  triggering the daemon shutdown path (shutdownAndExit) closes the
//         eights-client connection (isAvailableSync() -> false) and the
//         fixture child exits.
//   (iii) neither this test, nor anything it spawns, ever touches the REAL
//         ~/.eights or ~/.pair-programmer — snapshotted BEFORE any
//         HOME/USERPROFILE redirection (os.homedir() follows those env vars
//         once set) and compared unchanged after.
//
// Self-contained: spawns only the fake fixture (fixtures/fake-eights-daemon.mjs)
// and a fixture caller script (fixtures/eights-lifecycle-short-lived-caller.mjs).
// No live TheEights daemon, no network. `grep -c
// "C:\\\\AiAppDeployments\\\\TheEights"` against this file returns nothing —
// this file never references the real TheEights entrypoint path.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  existsSync,
  statSync,
  readFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const FIXTURE = join(__dirname, "fixtures", "fake-eights-daemon.mjs");
const SHORT_LIVED_CALLER = join(__dirname, "fixtures", "eights-lifecycle-short-lived-caller.mjs");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

// ── (iii) snapshot the REAL home BEFORE any HOME/USERPROFILE redirection ──
// os.homedir() on Windows resolves via USERPROFILE (falling back to
// HOMEDRIVE+HOMEPATH); once this test redirects those env vars for isolation
// below, os.homedir() would silently follow the redirected value, so the
// "real" path MUST be captured now, at module load, before anything mutates
// process.env.
const REAL_HOME = os.homedir();
const REAL_EIGHTS_DIR = join(REAL_HOME, ".eights");
const REAL_PP_DIR = join(REAL_HOME, ".pair-programmer");

function snapshotDir(p) {
  if (!existsSync(p)) return { exists: false };
  const st = statSync(p);
  return { exists: true, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() };
}

const beforeEightsSnapshot = snapshotDir(REAL_EIGHTS_DIR);
const beforePpSnapshot = snapshotDir(REAL_PP_DIR);

// ── Isolated env: redirect HOME/USERPROFILE + every state-path env var to
// throwaway temp dirs BEFORE importing anything under dist/ (module-load-time
// env reads, per the ANTI-STALL TEST RULE convention). ──────────────────────
const isolatedHome = mkdtempSync(join(tmpdir(), "pp-lifecycle-home-"));
const eightsHomeDir = join(isolatedHome, ".eights-home-marker");
const ppHomeDir = join(isolatedHome, "pp-home");
const ppDbPath = join(ppHomeDir, ".pair-programmer", "state.db");

process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.HOMEDRIVE = isolatedHome.slice(0, 2); // e.g. "C:"
process.env.HOMEPATH = isolatedHome.slice(2);
delete process.env.PP_ECOSYSTEM_DISABLED; // this file is the legitimate exception; see eights-client-listtools.unit.mjs
process.env.PP_HOME = ppHomeDir;
process.env.PP_DB_PATH = ppDbPath;
process.env.PP_EIGHTS_DAEMON = FIXTURE;
process.env.PP_ECOSYSTEM_PROBE_TIMEOUT_MS = "20000";
// EIGHTS_HOME is on eights-client.ts's frozen EIGHTS_FORWARDED_ENV_VARS
// allowlist and is reused here as the carrier for the fixture's pid-file
// directory (see fake-eights-daemon.mjs's updated header comment) — no new
// var added to that production-audited allowlist.
process.env.EIGHTS_HOME = eightsHomeDir;
process.env.PP_TEST_DIST_DIR = DIST;

/**
 * Retry `process.kill(pid, 0)` until it throws ESRCH (process genuinely
 * gone) or `timeoutMs` elapses. Distinguishes ESRCH (no such process — what
 * we want) from EPERM (process exists but we lack permission to signal it —
 * a real Windows possibility that must NOT be misread as "already dead").
 */
async function assertProcessTerminated(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastCode = null;
  for (;;) {
    try {
      process.kill(pid, 0);
      lastCode = "alive";
    } catch (err) {
      if (err && err.code === "ESRCH") return; // confirmed gone
      lastCode = err && err.code ? err.code : String(err);
    }
    if (Date.now() > deadline) {
      assert.fail(
        `pid ${pid} was not confirmed terminated within ${timeoutMs}ms ` +
          `(last process.kill(pid, 0) outcome: ${lastCode})`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("eights-client process lifecycle (L1B)", () => {
  after(() => {
    try { rmSync(isolatedHome, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  });

  it("(i) a short-lived caller (fire-and-forget write, returns from main) exits on its own within ~10s, and the fixture it talked to is confirmed dead afterward", async () => {
    const child = spawn(process.execPath, [SHORT_LIVED_CALLER], {
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });

    const exitInfo = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("short-lived caller did not exit within 10s — the unref fix regressed"));
      }, 10_000);
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });

    assert.equal(exitInfo.code, 0, `short-lived caller must exit 0, got ${JSON.stringify(exitInfo)}; stdout: ${stdout}`);

    const match = stdout.match(/FIXTURE_PID=(\d+)/);
    assert.ok(match, `short-lived caller must report FIXTURE_PID on stdout; got: ${JSON.stringify(stdout)}`);
    const fixturePid = Number(match[1]);

    // The caller never called shutdown() or process.exit() — mechanism (d)
    // (the process.on("exit") best-effort synchronous kill) is what actually
    // terminates the fixture once the caller's own event loop empties out.
    await assertProcessTerminated(fixturePid, 10_000);
  });

  it("(ii) triggering the daemon shutdown path closes the eights-client connection and the fixture child exits", async () => {
    const mod = await importDist("ecosystem/eights-client.js");
    const { shutdownAndExit } = await importDist("util/shutdown.js");

    const ok = await mod.isAvailable();
    assert.equal(ok, true, "must connect to the fixture before we can prove shutdown closes it");
    assert.equal(mod.isAvailableSync(), true);

    const fixturePid = mod.getConnectedDaemonPidForTesting();
    assert.ok(fixturePid, "expected a connected fixture pid");

    // exit: false — this IS the test process; we must not actually exit it.
    await shutdownAndExit("eights-lifecycle-unit-test", { exit: false });

    assert.equal(
      mod.isAvailableSync(),
      false,
      "eights-client state must no longer be 'available' after shutdownAndExit",
    );

    await assertProcessTerminated(fixturePid, 10_000);
  });

  it("(iii) the real ~/.eights and ~/.pair-programmer are untouched by this run", () => {
    const afterEightsSnapshot = snapshotDir(REAL_EIGHTS_DIR);
    const afterPpSnapshot = snapshotDir(REAL_PP_DIR);
    assert.deepStrictEqual(
      afterEightsSnapshot,
      beforeEightsSnapshot,
      "real ~/.eights changed during this test run — a lifecycle mechanism leaked outside the isolated HOME",
    );
    assert.deepStrictEqual(
      afterPpSnapshot,
      beforePpSnapshot,
      "real ~/.pair-programmer changed during this test run — a lifecycle mechanism leaked outside the isolated HOME",
    );
  });

  it("(iii) this file never references the real TheEights entrypoint path (grep-verifiable, not just runtime-verifiable)", () => {
    const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
    assert.doesNotMatch(
      self,
      /AiAppDeployments\\TheEights\\daemon\\dist\\index\.js/,
      "this lifecycle test must never spawn the real TheEights daemon; it must only ever talk to fake-eights-daemon.mjs",
    );
  });
});
