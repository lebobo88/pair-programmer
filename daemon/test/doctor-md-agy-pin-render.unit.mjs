// Unit test for P2 (gpt-5.6-terra, revise pass): /pp:doctor's prescribed
// checklist render (.claude/commands/pp/doctor.md and its .github mirror)
// must surface `agy_pin_check` (including its `note`, which carries the
// PP_DOCTOR_PIN_TIMEOUT_MS explanation for an inconclusive pin check) and
// `notes[]`. Before this fix, an operator whose `agy --version` resolved
// fine but whose `agy models` call went over budget had NO visible signal
// that the pinned-model check never actually completed.
//
// This is a content assertion on the prescribed-render markdown files
// themselves (not the doctor() payload, which is already covered by
// doctor-probe-timeout.unit.mjs / doctor-pin-freshness.unit.mjs) — the
// harness has no other automated check that the render instructions the
// agent reads actually mention these fields, so a future edit that trims
// this section back out would otherwise go undetected.
//
// Pure/offline: reads source .md files directly, no daemon/dist involved.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const DOCTOR_MD_PATHS = [
  join(REPO_ROOT, ".claude", "commands", "pp", "doctor.md"),
  join(REPO_ROOT, ".github", "commands", "pp", "doctor.md"),
];

for (const path of DOCTOR_MD_PATHS) {
  const label = path.includes(".github") ? ".github mirror" : ".claude source";

  test(`${label}: doctor.md render instructions mention agy_pin_check`, () => {
    const content = readFileSync(path, "utf8");
    assert.match(content, /agy_pin_check/, `${path} must instruct rendering agy_pin_check`);
    assert.match(content, /agy_pin_served/, `${path} must instruct rendering agy_pin_served`);
  });

  test(`${label}: doctor.md render instructions surface an inconclusive pin check's note (PP_DOCTOR_PIN_TIMEOUT_MS)`, () => {
    const content = readFileSync(path, "utf8");
    assert.match(
      content,
      /PP_DOCTOR_PIN_TIMEOUT_MS/,
      `${path} must name PP_DOCTOR_PIN_TIMEOUT_MS so an inconclusive agy_pin_check (agy models over budget) is explained, not silently dropped`,
    );
    assert.match(
      content,
      /note.*verbatim|verbatim.*note/is,
      `${path} must instruct printing agy_pin_check.note verbatim`,
    );
  });

  test(`${label}: doctor.md render instructions mention notes[]`, () => {
    const content = readFileSync(path, "utf8");
    assert.match(content, /\bnotes(\[\])?\b/, `${path} must instruct rendering the notes[] array`);
  });
}
