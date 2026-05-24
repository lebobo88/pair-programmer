// Unit test for R3-tail post-mortem Fix 1.1: selectTailFixProducer
// pure-function heuristic for routing surgical tail-fixes to test-strategist.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

let passed = 0;
let failed = 0;
function record(name, fn) {
  return fn().then(
    () => { console.log(`✓ ${name}`); passed++; },
    (err) => { console.error(`✗ ${name}\n  ${err.message}`); failed++; },
  );
}

await record("surgical tail-fix with findings_closed routes to test-strategist", async () => {
  const { selectTailFixProducer } = await importDist("orchestrator/gates.js");
  const decision = selectTailFixProducer({
    prior_attempt: {
      producer: "claude",
      status: "ok",
      notes_json: JSON.stringify({
        findings_closed: [
          { id: "C1", file: "apps/web/lib/idempotency.ts", lines: "187-201", claim: "added await" },
        ],
      }),
    },
    latest_critique_md: "Found at apps/web/lib/idempotency.ts:189 missing await",
    team_default_agent: "engineer",
  });
  assert.equal(decision.recommended_agent, "test-strategist");
  assert.match(decision.reason, /R3-tail/);
});

await record("status=needs_review with 1-2 files routes to test-strategist", async () => {
  const { selectTailFixProducer } = await importDist("orchestrator/gates.js");
  const decision = selectTailFixProducer({
    prior_attempt: {
      producer: "claude",
      status: "needs_review",
      notes_json: JSON.stringify({
        anti_pattern_hits: [
          { file: "apps/web/x.ts", line: 42, pattern: "void idempotencyKey" },
        ],
      }),
    },
    latest_critique_md: "anti-pattern at apps/web/x.ts:42",
    team_default_agent: "engineer",
  });
  assert.equal(decision.recommended_agent, "test-strategist");
  assert.match(decision.reason, /needs_review/);
});

await record("wide-scope critique stays on engineer", async () => {
  const { selectTailFixProducer } = await importDist("orchestrator/gates.js");
  const decision = selectTailFixProducer({
    prior_attempt: {
      producer: "claude",
      status: "ok",
      notes_json: null,
    },
    latest_critique_md:
      "issues across a/b.ts, c/d.ts, e/f.ts, g/h.ts, i/j.ts, k/l.ts, m/n.ts; " +
      "refactor needed in modules X, Y, Z; rewrite the auth flow end-to-end",
    team_default_agent: "engineer",
  });
  assert.equal(decision.recommended_agent, "engineer", "wide scope should NOT route to test-strategist");
});

await record("no notes + no critique defaults to engineer", async () => {
  const { selectTailFixProducer } = await importDist("orchestrator/gates.js");
  const decision = selectTailFixProducer({
    prior_attempt: {
      producer: "claude",
      status: "ok",
      notes_json: null,
    },
    latest_critique_md: "",
    team_default_agent: "engineer",
  });
  assert.equal(decision.recommended_agent, "engineer");
});

await record("team default of test-strategist is preserved when scope isn't surgical", async () => {
  const { selectTailFixProducer } = await importDist("orchestrator/gates.js");
  const decision = selectTailFixProducer({
    prior_attempt: {
      producer: "claude",
      status: "ok",
      notes_json: null,
    },
    latest_critique_md:
      "broad rewrite across many.ts, files.ts, here.ts, there.ts, everywhere.ts, etc.ts, more.ts",
    team_default_agent: "test-strategist",
  });
  assert.equal(decision.recommended_agent, "test-strategist", "team default honored");
});

await record("malformed notes_json doesn't crash", async () => {
  const { selectTailFixProducer } = await importDist("orchestrator/gates.js");
  const decision = selectTailFixProducer({
    prior_attempt: {
      producer: "claude",
      status: "ok",
      notes_json: "{not valid json",
    },
    latest_critique_md: "small fix at one.ts:10",
    team_default_agent: "engineer",
  });
  // Doesn't throw — falls back to default.
  assert.ok(["engineer", "test-strategist"].includes(decision.recommended_agent));
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
