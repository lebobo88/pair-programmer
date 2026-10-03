// L1B eights-lifecycle.unit.mjs fixture — case (i).
//
// Models a short-lived caller: a bare Node script that imports eights-client
// (the same module the `pp-daemon hook <event> <name>` CLI path pulls in via
// eights-writes.js), does ONE fire-and-forget write against the fake
// TheEights daemon, and returns from main WITHOUT ever calling
// `process.exit()` and WITHOUT ever calling `eights-client.shutdown()`.
//
// Before the L1B fix this hangs forever: the MCP SDK's StdioClientTransport
// refs the spawned child + its stdio pipes by default, so with no other
// pending work the event loop never empties. After the fix (mechanism (b) —
// ref/unref the child around each in-flight `safeCall`), the child is
// unref'd the moment the call settles, so this script's natural, unforced
// exit is not blocked by an eights-daemon connection nobody explicitly
// closed.
//
// Reports the fixture's pid on its own stdout (a well-known, single-line,
// machine-parseable marker) so the PARENT test process — which cannot see
// into this script's module state — can independently verify the fixture
// actually terminated after this script exits (see case (i) in
// eights-lifecycle.unit.mjs).

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const DIST = process.env.PP_TEST_DIST_DIR;
const mod = await import(pathToFileURL(join(DIST, "ecosystem", "eights-client.js")).href);

const envelope = mod.envelopeFor({
  run_id: "run_lifecycle_short_lived",
  project_path: "C:\\tmp\\fake-project-lifecycle",
});

await mod.memory.add({
  envelope,
  content: "fire-and-forget from short-lived caller",
  type: "semantic",
  provenance: { actor: "pp-unit-test-short-lived" },
});

const pid = mod.getConnectedDaemonPidForTesting();
console.log(`FIXTURE_PID=${pid}`);

// Deliberately: no shutdown(), no process.exit(). If this script's process
// doesn't exit on its own shortly after this point, the (b) unref fix (or
// the probe() connect-timer leak fix it depends on) regressed.
