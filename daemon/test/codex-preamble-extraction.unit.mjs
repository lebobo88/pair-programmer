/**
 * Regression guard for CODEX-PREAMBLE-WINS-OVER-ANSWER.
 *
 * WHAT BROKE: under `--output-schema` the codex CLI emits one `item.completed`
 * event per assistant turn, and each event carries a COMPLETE schema-conforming
 * JSON object. On any call where the model uses a tool -- e.g. a judge asked to
 * read files from disk -- that means TWO objects:
 *
 *     turn 1: {"outcome":"pass","critique_md":"I'll inspect the file..."}   <- preamble
 *     turn 2: {"outcome":"revise","critique_md":"<the actual critique>"}    <- real answer
 *
 * `parseCodexJsonl` concatenates event text, yielding `{...}{...}`. JSON.parse
 * rejects that, so callers fell through to `extractJsonValue`, whose
 * `extractFirstBalancedJson` returns the FIRST object -- the preamble. The model
 * had produced a correct answer and the bridge discarded it, then recorded the
 * planning narration as the verdict.
 *
 * Symptom in the wild: judge verdicts whose critique_md read "I'll inspect the
 * allowed source and test files..." with placeholder scores. It only ever showed
 * up on tool-using calls, which is why inlined-artifact critiques looked fine and
 * this shipped unnoticed.
 *
 * Self-contained per the ANTI-STALL TEST RULE: imports from dist/, no daemon.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractJsonValue,
  extractLastJsonValue,
} from "../dist/mcp/critique-schema.js";

// Shape of a real two-turn codex response after parseCodexJsonl concatenation.
const PREAMBLE = '{"outcome":"pass","critique_md":"I\'ll inspect the requested file header and report."}';
const ANSWER   = '{"outcome":"revise","critique_md":"The file declares a JsonObject record type."}';
const CONCATENATED = PREAMBLE + ANSWER;

describe("codex preamble extraction", () => {
  test("the concatenated two-turn payload is NOT valid JSON on its own", () => {
    // This is why the fallback path is reached at all. If this ever starts
    // parsing, the bridge changed shape and this whole guard needs revisiting.
    assert.throws(() => JSON.parse(CONCATENATED));
  });

  test("extractJsonValue returns the PREAMBLE -- documents the old broken behavior", () => {
    const r = extractJsonValue(CONCATENATED);
    assert.equal(r.found, true);
    assert.match(r.value.critique_md, /I'll inspect/);
  });

  test("extractLastJsonValue returns the REAL ANSWER, not the preamble", () => {
    const r = extractLastJsonValue(CONCATENATED);
    assert.equal(r.found, true);
    assert.equal(r.value.outcome, "revise");
    assert.match(
      r.value.critique_md,
      /JsonObject record type/,
      "the last balanced JSON object is the model's actual answer; returning the " +
        "first one records its planning preamble as the verdict",
    );
  });

  test("a single-turn payload is unaffected -- first and last coincide", () => {
    const solo = '{"outcome":"fail","critique_md":"solo answer"}';
    assert.deepEqual(extractLastJsonValue(solo).value, extractJsonValue(solo).value);
  });

  test("nested braces do not split an object", () => {
    const nested = '{"a":{"b":{"c":1}},"d":[{"e":2}]}';
    assert.deepEqual(extractLastJsonValue(nested).value, { a: { b: { c: 1 } }, d: [{ e: 2 }] });
  });

  test("three turns returns the last, not the middle", () => {
    const three = PREAMBLE + '{"outcome":"pass","critique_md":"middle"}' + ANSWER;
    assert.match(extractLastJsonValue(three).value.critique_md, /JsonObject record type/);
  });

  test("non-JSON input reports not-found rather than throwing", () => {
    assert.equal(extractLastJsonValue("not json at all").found, false);
    assert.equal(extractLastJsonValue("").found, false);
  });

  test("trailing prose after the final object still yields that object", () => {
    assert.equal(extractLastJsonValue(ANSWER + "\nDone.").value.outcome, "revise");
  });
});

// ─── Boundary-aware selection (the ROOT fix) ────────────────────────────────
//
// extractLastJsonValue scans a concatenated blob and so cannot tell an answer
// from brace-bearing prose in a later turn. The judge on run_WuP005xQIXS4 called
// that out as a patch over the real defect rather than a fix of it. The real fix
// is upstream: parseCodexJsonl now exposes `items[]` with event boundaries
// intact, and the consumer walks complete items backwards. These tests pin the
// difference, including the exact break scenario the judge constructed.
import { parseCodexJsonl } from "../dist/mcp/codex-server.js";

const evt = (text) => JSON.stringify({ type: "item.completed", item: { text } });

/** Mirror of the consumer walk in codexGenerate's output_schema branch. */
function pickLastParsableItem(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const candidate = (items[i] ?? "").trim();
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* keep walking */ }
  }
  return undefined;
}

describe("parseCodexJsonl boundary-aware item selection", () => {
  test("items[] preserves one entry per emitted event", () => {
    const jsonl = [evt(PREAMBLE), evt(ANSWER)].join("\n");
    const r = parseCodexJsonl(jsonl);
    assert.equal(r.items.length, 2);
    assert.equal(r.items[0], PREAMBLE);
    assert.equal(r.items[1], ANSWER);
    // text is still the lossy concatenation, kept for prose callers
    assert.equal(r.text, PREAMBLE + ANSWER);
  });

  test("walking items backwards selects the answer over the preamble", () => {
    const r = parseCodexJsonl([evt(PREAMBLE), evt(ANSWER)].join("\n"));
    assert.equal(pickLastParsableItem(r.items).outcome, "revise");
  });

  test("THE BREAK SCENARIO: a later turn containing valid JSON inside prose", () => {
    // extractLastJsonValue would return {"foo":1} here — it scans text and has no
    // event boundaries. The boundary-aware walk rejects the whole third item
    // (it does not parse as JSON in its entirety) and correctly falls back to the answer.
    const proseWithJson = 'note: see {"foo":1} for context';
    const r = parseCodexJsonl([evt(PREAMBLE), evt(ANSWER), evt(proseWithJson)].join("\n"));

    const boundaryAware = pickLastParsableItem(r.items);
    assert.equal(
      boundaryAware.critique_md,
      "The file declares a JsonObject record type.",
      "boundary-aware selection must return the real answer, not JSON embedded in later prose",
    );

    const textScan = extractLastJsonValue(r.text);
    assert.deepEqual(
      textScan.value,
      { foo: 1 },
      "documents WHY the boundary-aware path is the root fix: scanning the " +
        "concatenated text returns the wrong object here",
    );
  });

  test("a single-turn response is unaffected", () => {
    const r = parseCodexJsonl(evt(ANSWER));
    assert.equal(r.items.length, 1);
    assert.equal(pickLastParsableItem(r.items).outcome, "revise");
  });

  test("no parsable item yields undefined rather than a wrong object", () => {
    const r = parseCodexJsonl([evt("just prose"), evt("more prose")].join("\n"));
    assert.equal(pickLastParsableItem(r.items), undefined);
  });
});
