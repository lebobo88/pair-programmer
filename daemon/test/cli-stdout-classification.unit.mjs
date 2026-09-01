/**
 * Regression guard for the codex-stdout retry-classification defect.
 *
 * The codex CLI emits API errors as JSONL on STDOUT. `isPersistentStderr`
 * only ever saw stderr, so a deterministic HTTP 400 (invalid_json_schema)
 * was classified "transient" and consumed the full retry budget — ~$4.30 of
 * wasted spend in run_WuP005xQIXS4.
 *
 * These tests pin BOTH directions:
 *   - deterministic vendor faults on stdout  -> persistent (no retry)
 *   - 429 / 5xx / timeouts on stdout         -> transient  (still retried)
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { test, describe } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

// The shape codex actually emitted during run_WuP005xQIXS4.
const CODEX_400_JSONL = [
  '{"type":"session.created","session_id":"s_1"}',
  '{"type":"error","message":"400 Invalid schema for response_format \'critique\': invalid_json_schema"}',
].join("\n");

describe("isPersistentStdout — deterministic vendor faults", async () => {
  const { isPersistentStdout } = await importDist("mcp/cli-runner.js");

  test("codex JSONL error carrying invalid_json_schema is persistent", () => {
    assert.equal(
      isPersistentStdout(CODEX_400_JSONL),
      true,
      "a deterministic 400/invalid_json_schema on stdout must NOT be retried",
    );
  });

  test("invalid_request_error is persistent", () => {
    assert.equal(
      isPersistentStdout(
        '{"type":"error","error":{"type":"invalid_request_error","message":"unknown parameter"}}',
      ),
      true,
    );
  });

  test('explicit 4xx status on a "type":"error" event is persistent', () => {
    assert.equal(
      isPersistentStdout('{"type":"error","status":403,"message":"forbidden"}'),
      true,
    );
  });
});

describe("isPersistentStdout — transients must stay transient", async () => {
  const { isPersistentStdout } = await importDist("mcp/cli-runner.js");

  test("429 rate limit stays transient", () => {
    assert.equal(
      isPersistentStdout(
        '{"type":"error","status":429,"message":"rate_limit_exceeded: slow down"}',
      ),
      false,
      "429 is retryable — classifying it persistent would abandon recoverable work",
    );
  });

  test("500-class server error stays transient", () => {
    assert.equal(
      isPersistentStdout('{"type":"error","status":503,"message":"service unavailable"}'),
      false,
    );
  });

  test("a 429 line that also mentions invalid_request_error stays transient (veto wins)", () => {
    assert.equal(
      isPersistentStdout(
        '{"type":"error","status":429,"message":"invalid_request_error retry after rate limit"}',
      ),
      false,
    );
  });

  test("ordinary model output mentioning errors is not persistent", () => {
    assert.equal(
      isPersistentStdout(
        "The reviewer notes an error in handling status 400 responses; consider a schema guard.",
      ),
      false,
      "prose mentioning 400 must not short-circuit the retry",
    );
  });

  test("empty stdout is not persistent", () => {
    assert.equal(isPersistentStdout(""), false);
  });
});

describe("stderr classification is unchanged", async () => {
  const { isPersistentStderr } = await importDist("mcp/cli-runner.js");

  test("agy model-id rejection still persistent", () => {
    assert.equal(
      isPersistentStderr("model x is not recognized as a known model in settings"),
      true,
    );
  });

  test("ECONNRESET still transient", () => {
    assert.equal(isPersistentStderr("read ECONNRESET"), false);
  });

  test("codex stdout JSONL is not matched by the stderr classifier", () => {
    assert.equal(
      isPersistentStderr(CODEX_400_JSONL),
      false,
      "this is precisely why the stdout predicate had to be added",
    );
  });
});

// ─── Buffer-wide veto (cross-vendor judge finding, run_tYE0v6WrwFWs) ────────
//
// The first revision applied the transient veto PER LINE with `continue`, so it
// skipped only the offending line. A JSONL buffer whose first line was a
// deterministic 400 and whose fiftieth line was a 429 therefore returned
// `persistent` before the 429 was ever examined -- i.e. it stopped retrying a
// genuine rate limit. That is strictly worse than the bug the function exists to
// fix, and the original hand-probe missed it because it put both markers on the
// SAME line. These guards pin the multi-line arrangement.
describe("isPersistentStdout — veto applies to the whole buffer, not per line", async () => {
  const { isPersistentStdout } = await importDist("mcp/cli-runner.js");
  const NL = String.fromCharCode(10);
  const det = '{"type":"error","message":"invalid_json_schema","status":400}';
  const rate = '{"type":"error","message":"rate_limit_exceeded","status":429}';
  const noise = '{"type":"item.completed","item":{"text":"working"}}';

  test("deterministic on line 1, 429 fifty lines later -> TRANSIENT", () => {
    const buf = [det, ...Array(48).fill(noise), rate].join(NL);
    assert.equal(
      isPersistentStdout(buf),
      false,
      "a rate limit anywhere in the buffer must veto: refusing to retry a 429 is " +
        "worse than the deterministic-failure retry this function prevents",
    );
  });

  test("429 first, deterministic later -> TRANSIENT", () => {
    assert.equal(isPersistentStdout([rate, det].join(NL)), false);
  });

  test("5xx anywhere vetoes", () => {
    assert.equal(isPersistentStdout([det, '{"type":"error","status":503}'].join(NL)), false);
  });

  test("connection reset vetoes", () => {
    assert.equal(isPersistentStdout([det, "connection reset by peer"].join(NL)), false);
  });

  test("deterministic among unrelated noise still classifies persistent", () => {
    assert.equal(isPersistentStdout([noise, det, noise].join(NL)), true);
  });

  // The predicate now requires a STRUCTURED error event. Previously it was
  // `isErrorEvent || namedFault`, so ordinary model output quoting the marker --
  // for instance a critique discussing this very code -- classified persistent.
  test("prose merely quoting the marker is NOT persistent", () => {
    assert.equal(
      isPersistentStdout("the reviewer mentioned invalid_request_error in passing"),
      false,
      "a bare mention must not short-circuit the retry; a real event is required",
    );
  });

  test("prose plus a real error event IS persistent", () => {
    const buf = ["the reviewer mentioned invalid_request_error in passing", det].join(NL);
    assert.equal(isPersistentStdout(buf), true);
  });
});

// F-03 (judge finding, run_tYE0v6WrwFWs): only `connection reset` had a direct
// veto test, so deleting the socket-error entries left the suite green. One case
// per marker, so removing any single entry now goes red.
describe("isPersistentStdout — every transient socket marker is individually vetoed", async () => {
  const { isPersistentStdout } = await importDist("mcp/cli-runner.js");
  const NL = String.fromCharCode(10);
  const det = '{"type":"error","message":"invalid_json_schema","status":400}';

  for (const marker of [
    "connection reset by peer",
    "read ECONNRESET",
    "write EPIPE",
    "connect ETIMEDOUT 10.0.0.1:443",
    "connect ECONNREFUSED 127.0.0.1:8080",
    "socket hang up",
  ]) {
    test(`"${marker}" vetoes an otherwise-deterministic buffer`, () => {
      assert.equal(
        isPersistentStdout([det, marker].join(NL)),
        false,
        `${marker} is a recoverable transport fault; classifying the buffer persistent ` +
          "would abandon work that a retry would complete",
      );
    });
  }
});
