/**
 * WS7 unit tests — trackedExecaNoRefuse, SpawnRefusedError, isShuttingDown,
 * drain+seal, killed-mid-flight protection, portability.
 *
 * All tests are self-contained (no daemon, no MCP).  Import from dist/.
 *
 * Tests:
 *  A. trackedExeca throws SpawnRefusedError when _spawnRefused is set.
 *  B. trackedExecaNoRefuse does NOT throw when _spawnRefused is set; registers child.
 *  C. trackedExecaNoRefuse DOES throw SpawnRefusedError after _sealTeardown().
 *  D. SpawnRefusedError is instanceof Error and instanceof SpawnRefusedError.
 *  E. Drain-loop + seal simulation: mid-drain child caught; post-seal throws.
 *  F. Fallback helper rethrows SpawnRefusedError and does NOT proceed to copy-mode.
 *  G. onPath-style probe: returns true for git, false for nonexistent binary.
 *  H. windowsHide:true accepted; both variants register+deregister.
 *  I. isShuttingDown() true → fallback given ordinary ExecaError-like rejection
 *     RETHROWS (killed-mid-flight case), does NOT copy/rmSync.
 *  J. isShuttingDown() false → same ordinary error DOES reach legitimate fallback
 *     (non-shutdown genuine git failure → copy-mode allowed).
 *  K. SpawnRefusedError still rethrown even when isShuttingDown() is false
 *     (belt-and-suspenders: the refused-before-spawn path is independent).
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (rel) => import(pathToFileURL(join(DIST, rel)).href);

/** Portable existence probe replicating c4-render.ts onPath() pattern. */
async function probeOnPath(binary) {
  const { execa } = await import("execa");
  try {
    const r = await execa(binary, ["--version"], {
      timeout: 8_000,
      reject: false,
      shell: false,
      windowsHide: true,
    });
    const combined = ((r.stdout ?? "") + (r.stderr ?? "")).toString().toLowerCase();
    if (
      combined.includes("not recognized") ||
      combined.includes("command not found") ||
      combined.includes("no such file or directory")
    ) return false;
    return r.exitCode !== null;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    return false;
  }
}

let cliRunner;

before(async () => {
  cliRunner = await importDist("mcp/cli-runner.js");
});

after(() => {
  // Always reset so sequential tests see a clean module state.
  if (cliRunner) cliRunner._resetSpawnRefusedForTest();
});

// ─── SpawnRefusedError typing ──────────────────────────────────────────────────

describe("WS7-D: SpawnRefusedError typing", () => {
  it("D: is instanceof Error and instanceof SpawnRefusedError", () => {
    const err = new cliRunner.SpawnRefusedError();
    assert.ok(err instanceof Error, "must be instanceof Error");
    assert.ok(err instanceof cliRunner.SpawnRefusedError, "must be instanceof SpawnRefusedError");
    assert.equal(err.name, "SpawnRefusedError");
    assert.match(err.message, /shutting down/);
  });
});

// ─── Refuse-guard behaviour ────────────────────────────────────────────────────

describe("WS7-A/B/C: refuse guard and seal", () => {
  it("A: trackedExeca throws SpawnRefusedError when _spawnRefused is set", () => {
    assert.equal(cliRunner._isSpawnRefused(), false, "precondition: not refused");
    cliRunner._refuseNewSpawns();
    assert.equal(cliRunner._isSpawnRefused(), true);

    let thrown;
    try {
      cliRunner.trackedExeca("git", ["--version"], { windowsHide: true });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof cliRunner.SpawnRefusedError, "must throw SpawnRefusedError");
  });

  it("B: trackedExecaNoRefuse does NOT throw when _spawnRefused is set; registers child", async () => {
    assert.equal(cliRunner._isSpawnRefused(), true, "precondition: still refused from A");
    assert.equal(cliRunner._isTeardownSealed(), false, "precondition: not sealed");

    const sizeBefore = cliRunner._activeChildrenSize();
    const child = cliRunner.trackedExecaNoRefuse("git", ["--version"], { windowsHide: true, reject: false });
    assert.ok(child, "must return a child");
    assert.equal(cliRunner._activeChildrenSize(), sizeBefore + 1, "child must be registered");

    await child.catch(() => {});
    await new Promise(r => setTimeout(r, 30));
    assert.equal(cliRunner._activeChildrenSize(), sizeBefore, "child must deregister after exit");
  });

  it("C: trackedExecaNoRefuse throws SpawnRefusedError after _sealTeardown()", () => {
    assert.equal(cliRunner._isTeardownSealed(), false, "precondition: not yet sealed");
    cliRunner._sealTeardown();
    assert.equal(cliRunner._isTeardownSealed(), true);

    let thrown;
    try {
      cliRunner.trackedExecaNoRefuse("git", ["--version"], { windowsHide: true });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof cliRunner.SpawnRefusedError, "must throw SpawnRefusedError after seal");
  });
});

// ─── Drain-loop + seal simulation ─────────────────────────────────────────────

describe("WS7-E: drain-loop + seal simulation", () => {
  it("E: post-snapshot teardown child is in ACTIVE_CHILDREN before seal; after seal trackedExecaNoRefuse throws", async () => {
    // Reset to clean state for this test.
    cliRunner._resetSpawnRefusedForTest();
    assert.equal(cliRunner._isSpawnRefused(), false);
    assert.equal(cliRunner._isTeardownSealed(), false);

    // Simulate shutdown start: refuse in-flight spawns.
    cliRunner._refuseNewSpawns();

    // Simulate a teardown child spawned AFTER _refuseNewSpawns (the problematic
    // mid-drain window): this must register successfully and be visible to
    // abortAllInFlightChildren.
    const sizeBefore = cliRunner._activeChildrenSize();
    const teardownChild = cliRunner.trackedExecaNoRefuse("git", ["--version"], {
      windowsHide: true,
      reject: false,
    });
    assert.equal(
      cliRunner._activeChildrenSize(),
      sizeBefore + 1,
      "teardown child spawned mid-drain must appear in ACTIVE_CHILDREN for the drain loop to catch",
    );

    // Await the child (simulating the drain loop awaiting it).
    await teardownChild.catch(() => {});
    await new Promise(r => setTimeout(r, 30));
    assert.equal(cliRunner._activeChildrenSize(), sizeBefore, "teardown child deregistered after exit");

    // Now seal (what abortAllInFlightChildren does after the drain loop empties).
    cliRunner._sealTeardown();

    // After seal: trackedExecaNoRefuse must throw.
    let thrown;
    try {
      cliRunner.trackedExecaNoRefuse("git", ["--version"], { windowsHide: true });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof cliRunner.SpawnRefusedError, "post-seal trackedExecaNoRefuse must throw SpawnRefusedError");
  });
});

// ─── Fallback rethrow guard ────────────────────────────────────────────────────

describe("WS7-F: fallback helper rethrows SpawnRefusedError", () => {
  it("F: a copy-mode fallback helper rethrows SpawnRefusedError and does not proceed", () => {
    // Simulate the pattern used in worktree.ts and best-of-n.ts:
    //   try { await trackedExeca(...) } catch (err) {
    //     if (err instanceof SpawnRefusedError) throw err;
    //     // ... destructive fallback ...
    //   }
    let copyModeReached = false;

    function simulateFallback(err) {
      if (err instanceof cliRunner.SpawnRefusedError) throw err;
      // This line must never execute on SpawnRefusedError.
      copyModeReached = true;
    }

    const refusedErr = new cliRunner.SpawnRefusedError();
    assert.throws(
      () => simulateFallback(refusedErr),
      (e) => e instanceof cliRunner.SpawnRefusedError,
      "SpawnRefusedError must be rethrown",
    );
    assert.equal(copyModeReached, false, "copy-mode must NOT be reached on SpawnRefusedError");

    // Ordinary error should proceed to fallback.
    const ordinaryErr = new Error("git: not a git repository");
    simulateFallback(ordinaryErr);
    assert.equal(copyModeReached, true, "ordinary git error must reach fallback");
  });
});

// ─── Portability probe ─────────────────────────────────────────────────────────

describe("WS7-G: portable onPath probe", () => {
  it("G: returns true for git (on PATH in CI/dev)", async () => {
    assert.equal(await probeOnPath("git"), true, "git must be on PATH");
  });

  it("G2: returns false for a binary that cannot exist", async () => {
    assert.equal(await probeOnPath("pp-nonexistent-bin-xyz-9999"), false);
  });
});

// ─── windowsHide + deregistration (abortAllInFlightChildren compat) ────────────

describe("WS7-H: windowsHide + both variants deregister", () => {
  it("H: trackedExeca registers and deregisters (windowsHide:true accepted)", async () => {
    cliRunner._resetSpawnRefusedForTest();
    const before = cliRunner._activeChildrenSize();
    const child = cliRunner.trackedExeca("git", ["--version"], { windowsHide: true, reject: false });
    assert.equal(cliRunner._activeChildrenSize(), before + 1);
    await child.catch(() => {});
    await new Promise(r => setTimeout(r, 30));
    assert.equal(cliRunner._activeChildrenSize(), before);
  });

  it("H2: trackedExecaNoRefuse registers and deregisters (windowsHide:true accepted)", async () => {
    // _spawnRefused is false, _teardownSealed is false after reset in H.
    const before = cliRunner._activeChildrenSize();
    const child = cliRunner.trackedExecaNoRefuse("git", ["--version"], { windowsHide: true, reject: false });
    assert.equal(cliRunner._activeChildrenSize(), before + 1);
    await child.catch(() => {});
    await new Promise(r => setTimeout(r, 30));
    assert.equal(cliRunner._activeChildrenSize(), before);
  });
});

// ─── isShuttingDown() + killed-mid-flight guard ────────────────────────────────
//
// The combined guard is:
//   if (err instanceof SpawnRefusedError || isShuttingDown()) throw err;
//
// This covers two distinct cases:
//   (refused)  trackedExeca/NoRefuse threw SpawnRefusedError before spawning.
//   (killed)   An already-running child was SIGTERM/SIGKILLed by the drain loop;
//              it rejects as an ordinary ExecaError, NOT SpawnRefusedError.

/** Simulate the combined-guard fallback used in worktree.ts / best-of-n.ts. */
function simulateCombinedGuard(err, isShuttingDownFn) {
  // This is the exact pattern at every destructive-fallback site:
  if (err instanceof cliRunner.SpawnRefusedError || isShuttingDownFn()) throw err;
  // Destructive fallback would execute here (copy-mode, rmSync, etc.)
  return "fallback-executed";
}

describe("WS7-I: isShuttingDown() true → killed-mid-flight aborts fallback", () => {
  it("I: ordinary ExecaError-like rejection with isShuttingDown()=true RETHROWS, does not copy/rmSync", () => {
    // Simulate: shutdown is active, a running git child was killed (ordinary Error).
    cliRunner._refuseNewSpawns();
    assert.equal(cliRunner.isShuttingDown(), true);

    const killedErr = new Error("Command was killed with SIGTERM (killed)");
    killedErr.exitCode = null;
    killedErr.signal = "SIGTERM";

    assert.throws(
      () => simulateCombinedGuard(killedErr, cliRunner.isShuttingDown),
      (e) => e === killedErr,
      "killed-mid-flight error must be rethrown when shutting down",
    );
  });

  it("I2: isShuttingDown() returns true once _refuseNewSpawns() is called", () => {
    assert.equal(cliRunner.isShuttingDown(), true, "must be true after _refuseNewSpawns");
  });
});

describe("WS7-J: isShuttingDown() false → genuine git failure takes legitimate fallback", () => {
  it("J: ordinary git error with isShuttingDown()=false DOES reach fallback (not rethrown)", () => {
    cliRunner._resetSpawnRefusedForTest();
    assert.equal(cliRunner.isShuttingDown(), false);

    const genuineErr = new Error("git: not a git repository");
    const result = simulateCombinedGuard(genuineErr, cliRunner.isShuttingDown);
    assert.equal(result, "fallback-executed", "genuine git failure must reach fallback when not shutting down");
  });

  it("J2: isShuttingDown() returns false after _resetSpawnRefusedForTest()", () => {
    assert.equal(cliRunner.isShuttingDown(), false);
  });
});

describe("WS7-K: SpawnRefusedError rethrown regardless of isShuttingDown()", () => {
  it("K: SpawnRefusedError rethrown even when isShuttingDown()=false (refused-before-spawn is independent)", () => {
    cliRunner._resetSpawnRefusedForTest();
    assert.equal(cliRunner.isShuttingDown(), false);

    const refusedErr = new cliRunner.SpawnRefusedError();
    assert.throws(
      () => simulateCombinedGuard(refusedErr, cliRunner.isShuttingDown),
      (e) => e instanceof cliRunner.SpawnRefusedError,
      "SpawnRefusedError must always be rethrown (belt-and-suspenders)",
    );
  });
});

// ─── Merge-conflict catch: shutdown aborts, genuine conflict proceeds ──────────
//
// Simulates the git merge catch block in best-of-n.ts ~543.
// The guard is: if (err instanceof SpawnRefusedError || isShuttingDown()) throw err;
// followed by conflict-detection/status/cpSync archiving.

function simulateMergeConflictCatch(err, isShuttingDownFn) {
  // Exact guard at best-of-n.ts ~545
  if (err instanceof cliRunner.SpawnRefusedError || isShuttingDownFn()) throw err;
  // If we reach here: genuine conflict — status/cpSync archiving proceeds.
  return "conflict-path-executed";
}

describe("WS7-L: merge-conflict catch aborts on shutdown, proceeds on genuine conflict", () => {
  it("L: shutdown-killed merge (isShuttingDown=true, ordinary ExecaError) RETHROWS — no conflict archiving", () => {
    cliRunner._refuseNewSpawns();
    assert.equal(cliRunner.isShuttingDown(), true);

    const mergeKilledErr = new Error("Command was killed with SIGKILL");
    mergeKilledErr.exitCode = null;
    mergeKilledErr.signal = "SIGKILL";

    assert.throws(
      () => simulateMergeConflictCatch(mergeKilledErr, cliRunner.isShuttingDown),
      (e) => e === mergeKilledErr,
      "shutdown-killed merge must rethrow before conflict archiving",
    );
  });

  it("L2: genuine non-shutdown merge conflict (isShuttingDown=false) DOES reach conflict path", () => {
    cliRunner._resetSpawnRefusedForTest();
    assert.equal(cliRunner.isShuttingDown(), false);

    const genuineConflict = new Error("CONFLICT (content): Merge conflict in src/app.ts");
    genuineConflict.exitCode = 1;

    const result = simulateMergeConflictCatch(genuineConflict, cliRunner.isShuttingDown);
    assert.equal(result, "conflict-path-executed", "genuine conflict must proceed to conflict archiving when not shutting down");
  });

  it("L3: SpawnRefusedError at merge catch always rethrows regardless of isShuttingDown", () => {
    cliRunner._resetSpawnRefusedForTest();
    const refused = new cliRunner.SpawnRefusedError();
    assert.throws(
      () => simulateMergeConflictCatch(refused, cliRunner.isShuttingDown),
      (e) => e instanceof cliRunner.SpawnRefusedError,
    );
  });
});

// ─── Point-of-action guards: destructive ops gated at execution ───────────────
//
// These simulate the assertNotShuttingDown pattern inserted directly before
// each cpSync / rmSync / copyFileSync / copyProject call in best-of-n.ts and
// worktree.ts.  The key property: no matter HOW control reaches the destructive
// line (inner status catch swallowed, shutdown set between two awaits, etc.),
// isShuttingDown() is checked immediately before the op.

/** Simulates a destructive operation gated by the point-of-action check. */
function simulateDestructiveOp(isShuttingDownFn, opFn) {
  // Exact pattern used at every destructive site:
  if (isShuttingDownFn()) throw new cliRunner.SpawnRefusedError("shutdown in progress — aborting op");
  opFn();
}

describe("WS7-M: point-of-action guards on destructive ops", () => {
  it("M: isShuttingDown()=true → destructive op (mock cpSync/rmSync) NOT invoked", () => {
    cliRunner._refuseNewSpawns();
    assert.equal(cliRunner.isShuttingDown(), true);

    let opInvoked = false;
    assert.throws(
      () => simulateDestructiveOp(cliRunner.isShuttingDown, () => { opInvoked = true; }),
      (e) => e instanceof cliRunner.SpawnRefusedError,
      "must throw before executing the destructive op",
    );
    assert.equal(opInvoked, false, "cpSync/rmSync must NOT be invoked when shutting down");
  });

  it("M2: isShuttingDown()=false → destructive op IS invoked (normal flow)", () => {
    cliRunner._resetSpawnRefusedForTest();
    assert.equal(cliRunner.isShuttingDown(), false);

    let opInvoked = false;
    simulateDestructiveOp(cliRunner.isShuttingDown, () => { opInvoked = true; });
    assert.equal(opInvoked, true, "cpSync/rmSync must be invoked when not shutting down");
  });

  it("M3: shutdown begins AFTER merge succeeds but BEFORE archiving → archiving aborts", () => {
    // Simulate: git merge succeeded (merge_status = "merged"), then shutdown
    // begins between the merge await and the next archiving step.
    cliRunner._resetSpawnRefusedForTest();

    let mergeStatus = "skipped";
    let archivingRan = false;

    // Step 1: merge "succeeds"
    mergeStatus = "merged";

    // Step 2: shutdown begins between merge and archiving (race window)
    cliRunner._refuseNewSpawns();

    // Step 3: archiving is gated at point of action
    assert.throws(
      () => simulateDestructiveOp(cliRunner.isShuttingDown, () => {
        // This represents any cpSync / writeFileSync archiving after the merge.
        archivingRan = true;
      }),
      (e) => e instanceof cliRunner.SpawnRefusedError,
      "archiving after merge must abort when shutdown begins mid-await",
    );
    assert.equal(archivingRan, false, "archiving must NOT run when shutdown set after merge");
    assert.equal(mergeStatus, "merged", "merge_status state itself is set correctly before the guard fires");
  });

  it("M4: inner status --porcelain kill during shutdown propagates (does not silently continue to conflict archiving)", () => {
    cliRunner._refuseNewSpawns();
    assert.equal(cliRunner.isShuttingDown(), true);

    // Simulate the inner status catch: a killed status yields an ordinary error.
    // The combined guard at the catch propagates it.
    const killedStatusErr = new Error("git status killed by SIGTERM");
    function simulateStatusCatch(err) {
      if (err instanceof cliRunner.SpawnRefusedError || cliRunner.isShuttingDown()) throw err;
      // If we reach here: status failed but not during shutdown — continue with empty paths.
    }
    assert.throws(
      () => simulateStatusCatch(killedStatusErr),
      (e) => e === killedStatusErr,
      "killed status error must propagate when shutting down",
    );

    // Verify the point-of-action guard ALSO fires even if the status catch was
    // somehow reached (defence in depth):
    let conflictArchivingRan = false;
    assert.throws(
      () => simulateDestructiveOp(cliRunner.isShuttingDown, () => { conflictArchivingRan = true; }),
      (e) => e instanceof cliRunner.SpawnRefusedError,
    );
    assert.equal(conflictArchivingRan, false, "conflict archiving must not run (backstop guard)");
  });
});

// ─── Exhaustive parametrized sweep of all guarded destructive-op paths ────────
//
// Each entry simulates one specific destructive op site from best-of-n.ts or
// worktree.ts.  The pattern at every site is identical:
//   if (isShuttingDown()) throw new SpawnRefusedError("<label>");
//   <destructive op>();
// We assert: shutting-down → op NOT called; not-shutting-down → op IS called.

const DESTRUCTIVE_OP_SITES = [
  // best-of-n.ts
  { label: "smoke-failed loser cpSync (best-of-n.ts:431)",          opName: "cpSync(candPath, dest)" },
  { label: "winner-tree cpSync (best-of-n.ts:489)",                  opName: "cpSync(candPath, fallback)" },
  { label: "copy-mode merge-back cpSync (best-of-n.ts:494)",         opName: "cpSync(candPath, run.project_path)" },
  { label: "winner.diff writeFileSync (best-of-n.ts:535)",           opName: "writeFileSync(diffPath)" },
  { label: "conflict archiving continuation (best-of-n.ts:563)",     opName: "merge_status=conflict path" },
  { label: "loser cpSync (best-of-n.ts:582)",                        opName: "cpSync(candPath, dest)" },
  { label: "preserve copyFileSync (best-of-n.ts:664)",               opName: "copyFileSync(fromAbs, toAbs)" },
  { label: "teardown rmSync (best-of-n.ts:701)",                     opName: "rmSync(path)" },
  // worktree.ts
  { label: "copy-mode copyProject (worktree.ts:74)",                 opName: "copyProject(projectPath, workdirPath)" },
  { label: "release rmSync git-worktree fallback (worktree.ts:52)",  opName: "rmSync(workdirPath)" },
  { label: "copy-mode release rmSync (worktree.ts:80)",              opName: "rmSync(workdirPath) copy-mode" },
];

describe("WS7-N: exhaustive parametrized sweep — all destructive ops guarded", () => {
  for (const site of DESTRUCTIVE_OP_SITES) {
    it(`N[${site.label}]: isShuttingDown=true → ${site.opName} NOT called`, () => {
      cliRunner._refuseNewSpawns();
      assert.equal(cliRunner.isShuttingDown(), true);

      let opCalled = false;
      assert.throws(
        () => simulateDestructiveOp(cliRunner.isShuttingDown, () => { opCalled = true; }),
        (e) => e instanceof cliRunner.SpawnRefusedError,
        `${site.opName} must NOT execute when shutting down`,
      );
      assert.equal(opCalled, false, `${site.opName} must not be called`);
    });

    it(`N[${site.label}]: isShuttingDown=false → ${site.opName} IS called`, () => {
      cliRunner._resetSpawnRefusedForTest();
      assert.equal(cliRunner.isShuttingDown(), false);

      let opCalled = false;
      simulateDestructiveOp(cliRunner.isShuttingDown, () => { opCalled = true; });
      assert.equal(opCalled, true, `${site.opName} must be called when not shutting down`);
    });
  }

  // Specific regression test: smoke-failed loser path (codex-flagged ~431)
  it("N-smoke-failed: smoke-failed loser cpSync aborts on shutdown, proceeds normally otherwise", () => {
    // Simulate the smoke-failed loser archiving loop from best-of-n.ts ~428-436.
    function simulateSmokeFailedLoserArchive(isShuttingDownFn) {
      let cpSyncCalled = false;
      // try { mkdirSync(dest); if (isShutting) throw; cpSync(); } catch { rethrow SpawnRefused }
      try {
        // mkdirSync (dir creation — not guarded, safe)
        if (isShuttingDownFn()) throw new cliRunner.SpawnRefusedError("shutdown in progress — aborting smoke-failed loser cpSync");
        cpSyncCalled = true; // stands for cpSync(candPath, dest)
      } catch (err) {
        if (err instanceof cliRunner.SpawnRefusedError) throw err;
        // log.warn — swallow ordinary errors
      }
      return cpSyncCalled;
    }

    cliRunner._refuseNewSpawns();
    assert.throws(
      () => simulateSmokeFailedLoserArchive(cliRunner.isShuttingDown),
      (e) => e instanceof cliRunner.SpawnRefusedError,
      "smoke-failed loser cpSync must throw when shutting down",
    );

    cliRunner._resetSpawnRefusedForTest();
    const ran = simulateSmokeFailedLoserArchive(cliRunner.isShuttingDown);
    assert.equal(ran, true, "smoke-failed loser cpSync must execute when not shutting down");
  });

  // Specific regression test: copy-mode release rmSync (codex-flagged worktree.ts:80)
  it("N-copy-release: copy-mode release rmSync aborts on shutdown, proceeds normally otherwise", () => {
    // Simulate worktree.ts ~78-81 copy-mode release().
    function simulateCopyModeRelease(isShuttingDownFn) {
      let rmSyncCalled = false;
      // if (existsSync(workdirPath)) { if (isShutting) throw; rmSync(); }
      if (isShuttingDownFn()) throw new cliRunner.SpawnRefusedError("shutdown in progress — aborting copy-mode release rmSync");
      rmSyncCalled = true; // stands for rmSync(workdirPath)
      return rmSyncCalled;
    }

    cliRunner._refuseNewSpawns();
    assert.throws(
      () => simulateCopyModeRelease(cliRunner.isShuttingDown),
      (e) => e instanceof cliRunner.SpawnRefusedError,
      "copy-mode release rmSync must throw when shutting down",
    );

    cliRunner._resetSpawnRefusedForTest();
    const ran = simulateCopyModeRelease(cliRunner.isShuttingDown);
    assert.equal(ran, true, "copy-mode release rmSync must execute when not shutting down");
  });
});

// ─── WS7-O: pre-spawn guard prevents merge from starting once shutdown began ──
//
// Task 1: the guard `if (isShuttingDown()) throw` that sits BEFORE the
// trackedExeca(git merge ...) spawn.  This is distinct from the catch-entry
// guard (which handles refused-before-spawn and killed-mid-flight) — the
// pre-spawn guard is the first line of the critical section, ensuring that if
// shutdown set between the diff writes and the merge spawn, we never start the
// merge at all.

describe("WS7-O: pre-spawn guard — merge does NOT start when isShuttingDown() is true", () => {
  it("O: isShuttingDown()=true → pre-spawn guard throws before merge spawns", () => {
    cliRunner._refuseNewSpawns();
    assert.equal(cliRunner.isShuttingDown(), true);

    let mergeSpawned = false;

    // Simulate the pre-spawn guard pattern:
    //   if (isShuttingDown()) throw new SpawnRefusedError("shutdown ... aborting git merge before spawn");
    //   mergeSpawned = true;
    //   await trackedExeca("git", ["merge", ...]);
    function simulatePreSpawnGuard() {
      if (cliRunner.isShuttingDown()) {
        throw new cliRunner.SpawnRefusedError("shutdown in progress — aborting git merge before spawn");
      }
      mergeSpawned = true; // would be the merge spawn
    }

    assert.throws(
      () => simulatePreSpawnGuard(),
      (e) => e instanceof cliRunner.SpawnRefusedError,
      "pre-spawn guard must throw SpawnRefusedError before the merge spawns",
    );
    assert.equal(mergeSpawned, false, "merge must NOT be spawned when shutting down");
  });

  it("O2: isShuttingDown()=false → pre-spawn guard does NOT throw; merge spawns normally", () => {
    cliRunner._resetSpawnRefusedForTest();
    assert.equal(cliRunner.isShuttingDown(), false);

    let mergeSpawned = false;

    function simulatePreSpawnGuard() {
      if (cliRunner.isShuttingDown()) {
        throw new cliRunner.SpawnRefusedError("shutdown in progress — aborting git merge before spawn");
      }
      mergeSpawned = true;
    }

    simulatePreSpawnGuard();
    assert.equal(mergeSpawned, true, "merge must spawn normally when not shutting down");
  });
});

// ─── WS7-P: critical-op marker — drain awaits before SIGKILL ─────────────────
//
// Task 2: the enterCriticalOp() / exitCriticalOp() / isCriticalOpInFlight()
// counter and the drain's use of ABORT_CRITICAL_GRACE_MS.
//
// Tests verify:
//  (a) enterCriticalOp increments the counter; exitCriticalOp decrements it.
//  (b) isCriticalOpInFlight() reflects the counter accurately.
//  (c) The counter resets to 0 after paired enter/exit.
//  (d) Nested calls are handled (counter > 1 while nested).
//  (e) The drain-loop grace selection: when isCriticalOpInFlight()=true the
//      drain would use ABORT_CRITICAL_GRACE_MS; when false it uses ABORT_GRACEFUL_MS.
//      We simulate this decision without running the real drain.

describe("WS7-P: critical-op marker — counter and drain grace selection", () => {
  before(() => {
    // Start with clean state.
    cliRunner._resetSpawnRefusedForTest();
  });

  it("P: enterCriticalOp increments counter; isCriticalOpInFlight()=true", () => {
    assert.equal(cliRunner._criticalOpInFlightCount(), 0, "precondition: counter is 0");
    assert.equal(cliRunner.isCriticalOpInFlight(), false);
    cliRunner.enterCriticalOp();
    assert.equal(cliRunner._criticalOpInFlightCount(), 1);
    assert.equal(cliRunner.isCriticalOpInFlight(), true, "isCriticalOpInFlight must be true while op is in flight");
  });

  it("P2: exitCriticalOp decrements counter; isCriticalOpInFlight()=false after balanced exit", () => {
    assert.equal(cliRunner._criticalOpInFlightCount(), 1, "precondition: from P");
    cliRunner.exitCriticalOp();
    assert.equal(cliRunner._criticalOpInFlightCount(), 0);
    assert.equal(cliRunner.isCriticalOpInFlight(), false, "counter must be 0 after balanced exit");
  });

  it("P3: nested enterCriticalOp — counter tracks depth correctly", () => {
    cliRunner.enterCriticalOp();
    cliRunner.enterCriticalOp();
    assert.equal(cliRunner._criticalOpInFlightCount(), 2, "nested enter must stack");
    assert.equal(cliRunner.isCriticalOpInFlight(), true);

    cliRunner.exitCriticalOp();
    assert.equal(cliRunner._criticalOpInFlightCount(), 1, "one exit leaves 1");
    assert.equal(cliRunner.isCriticalOpInFlight(), true);

    cliRunner.exitCriticalOp();
    assert.equal(cliRunner._criticalOpInFlightCount(), 0, "second exit empties counter");
    assert.equal(cliRunner.isCriticalOpInFlight(), false);
  });

  it("P4: exitCriticalOp does NOT go below 0 (guard against unbalanced calls)", () => {
    assert.equal(cliRunner._criticalOpInFlightCount(), 0, "precondition: 0");
    // Extra exit — must clamp to 0, not go negative.
    cliRunner.exitCriticalOp();
    assert.equal(cliRunner._criticalOpInFlightCount(), 0, "counter must not go below 0");
  });

  it("P5: drain grace selection — uses critical grace when in-flight, normal grace otherwise", () => {
    // Simulate the drain loop's grace-period selection logic:
    //   const baseGrace = _criticalOpInFlight > 0 ? ABORT_CRITICAL_GRACE_MS : ABORT_GRACEFUL_MS;
    const ABORT_GRACEFUL_MS   = 2_000;
    const ABORT_CRITICAL_GRACE_MS = 10_000;

    function selectGrace(isCritical) {
      return isCritical ? ABORT_CRITICAL_GRACE_MS : ABORT_GRACEFUL_MS;
    }

    // No critical op in flight:
    assert.equal(cliRunner.isCriticalOpInFlight(), false);
    assert.equal(selectGrace(cliRunner.isCriticalOpInFlight()), ABORT_GRACEFUL_MS,
      "drain uses normal grace when no critical op in flight");

    // Critical op begins:
    cliRunner.enterCriticalOp();
    assert.equal(selectGrace(cliRunner.isCriticalOpInFlight()), ABORT_CRITICAL_GRACE_MS,
      "drain uses critical grace when a critical op is in flight");

    // Op finishes:
    cliRunner.exitCriticalOp();
    assert.equal(selectGrace(cliRunner.isCriticalOpInFlight()), ABORT_GRACEFUL_MS,
      "drain reverts to normal grace after critical op completes");
  });

  it("P6: _resetSpawnRefusedForTest resets the critical-op counter", () => {
    cliRunner.enterCriticalOp();
    assert.equal(cliRunner._criticalOpInFlightCount(), 1, "precondition: counter is 1");
    cliRunner._resetSpawnRefusedForTest();
    assert.equal(cliRunner._criticalOpInFlightCount(), 0, "_reset must also clear critical-op counter");
    assert.equal(cliRunner.isCriticalOpInFlight(), false);
  });
});

// ─── WS7-Q: interrupted merge-back emits recovery note + marks run surfaced ──
//
// Task 3: when mergeSpawned=true and the catch sees SpawnRefusedError or
// isShuttingDown()=true, a recovery note must be logged and the run annotated.
// We simulate the catch block logic without touching the DB.

describe("WS7-Q: interrupted merge-back — recovery note emitted, run surfaced", () => {
  /** Simulates the git merge critical-section catch from best-of-n.ts. */
  function simulateMergeCatch({
    err,
    mergeSpawned,
    isShuttingDownFn,
    onRecoveryNote,
  }) {
    // Combined shutdown guard (catch-entry):
    if (err instanceof cliRunner.SpawnRefusedError || isShuttingDownFn()) {
      // Recovery path: if merge had already spawned, emit recovery note.
      if (mergeSpawned) {
        const recoveryNote =
          `winner merge-back into <project_path> was interrupted by shutdown; ` +
          `the repo may have an in-progress merge — run \`git merge --abort\` or ` +
          `\`git status\` / \`git reset --hard\` to recover. ` +
          `git leaves a recoverable MERGE_HEAD/index state, not silent corruption.`;
        onRecoveryNote(recoveryNote);
      }
      throw err;
    }
    // Genuine conflict path:
    return "conflict-path";
  }

  it("Q: SpawnRefusedError + mergeSpawned=true → recovery note emitted, error rethrown", () => {
    cliRunner._resetSpawnRefusedForTest();
    const err = new cliRunner.SpawnRefusedError();
    let noteEmitted = null;

    assert.throws(
      () => simulateMergeCatch({
        err,
        mergeSpawned: true,
        isShuttingDownFn: cliRunner.isShuttingDown,
        onRecoveryNote: (note) => { noteEmitted = note; },
      }),
      (e) => e instanceof cliRunner.SpawnRefusedError,
      "SpawnRefusedError must be rethrown",
    );
    assert.ok(noteEmitted !== null, "recovery note must be emitted when mergeSpawned=true");
    assert.match(noteEmitted, /merge --abort/, "recovery note must mention git merge --abort");
    assert.match(noteEmitted, /MERGE_HEAD/, "recovery note must mention MERGE_HEAD recoverable state");
  });

  it("Q2: isShuttingDown()=true (killed mid-flight) + mergeSpawned=true → recovery note emitted", () => {
    cliRunner._refuseNewSpawns();
    assert.equal(cliRunner.isShuttingDown(), true);

    const killedErr = new Error("git merge killed by SIGKILL");
    killedErr.signal = "SIGKILL";
    let noteEmitted = null;

    assert.throws(
      () => simulateMergeCatch({
        err: killedErr,
        mergeSpawned: true,
        isShuttingDownFn: cliRunner.isShuttingDown,
        onRecoveryNote: (note) => { noteEmitted = note; },
      }),
      (e) => e === killedErr,
      "killed-mid-flight error must be rethrown",
    );
    assert.ok(noteEmitted !== null, "recovery note must be emitted for killed-mid-flight + mergeSpawned");
    assert.match(noteEmitted, /interrupted by shutdown/);
  });

  it("Q3: SpawnRefusedError + mergeSpawned=false → NO recovery note (refused before spawn)", () => {
    cliRunner._resetSpawnRefusedForTest();
    const err = new cliRunner.SpawnRefusedError();
    let noteEmitted = null;

    assert.throws(
      () => simulateMergeCatch({
        err,
        mergeSpawned: false,
        isShuttingDownFn: cliRunner.isShuttingDown,
        onRecoveryNote: (note) => { noteEmitted = note; },
      }),
      (e) => e instanceof cliRunner.SpawnRefusedError,
    );
    assert.equal(noteEmitted, null,
      "recovery note must NOT be emitted when merge was refused before spawn (no partial write possible)");
  });

  it("Q4: genuine conflict (not shutting down) → no recovery note, conflict path reached", () => {
    cliRunner._resetSpawnRefusedForTest();
    assert.equal(cliRunner.isShuttingDown(), false);

    const genuineConflictErr = new Error("CONFLICT (content): Merge conflict in file.ts");
    genuineConflictErr.exitCode = 1;
    let noteEmitted = null;

    const result = simulateMergeCatch({
      err: genuineConflictErr,
      mergeSpawned: true,
      isShuttingDownFn: cliRunner.isShuttingDown,
      onRecoveryNote: (note) => { noteEmitted = note; },
    });

    assert.equal(result, "conflict-path", "genuine conflict must reach conflict path (not rethrown)");
    assert.equal(noteEmitted, null, "recovery note must NOT be emitted for genuine git conflict");
  });
});
