// Unit tests for artifact-validator helpers. No subprocess, no MCP.
// Exercises pure code paths: ADR structure linter, command allowlist
// tokenizer / forbidden-pattern rejection, path-traversal refusal,
// validator-policy resolver.

import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist", "orchestrator", "artifact-validators");
const url = (rel) => pathToFileURL(join(DIST, rel)).href;

const { validateAdrStructure } = await import(url("adr-structure-lint.js"));
const {
  parseAndValidateCommand,
  CommandRejectedError,
  PathOutsideArtifactDirError,
  assertPathInProjectArtifactDir,
  tokenize,
} = await import(url("command-allowlist.js"));
const {
  requiredValidatorsForArtifact,
  strictValidators,
  VALIDATOR_KINDS,
} = await import(url("validator-policy.js"));
const {
  buildCritiqueOutputSchema,
  extractJsonValue,
  normalizeCritiqueResult,
  validateCritiqueResult,
} = await import(pathToFileURL(join(__dirname, "..", "dist", "mcp", "critique-schema.js")).href);
const {
  stabilizeCritiqueResult,
} = await import(pathToFileURL(join(__dirname, "..", "dist", "mcp", "critique-bridge.js")).href);
const {
  buildCodexExecArgs,
  parseCodexJsonl,
} = await import(pathToFileURL(join(__dirname, "..", "dist", "mcp", "codex-server.js")).href);
const {
  resolveSameVendorCapability,
  describeJudgeCapabilities,
} = await import(pathToFileURL(join(__dirname, "..", "dist", "orchestrator", "gates.js")).href);

let pass = 0;
let fail = 0;

function it(label, fn) {
  try {
    fn();
    pass++;
    console.log(`✓ ${label}`);
  } catch (err) {
    fail++;
    console.error(`✗ ${label}`);
    console.error(`  ${err.message}`);
  }
}

async function itAsync(label, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${label}`);
  } catch (err) {
    fail++;
    console.error(`✗ ${label}`);
    console.error(`  ${err.message}`);
  }
}

// ─── ADR structure linter ────────────────────────────────────────────────

const VALID = `# ADR-0001: Title

## Status

Accepted on 2026-01-01. Body is wider than forty characters of real content.

## Context

A reasonably long context paragraph that easily exceeds the forty character
minimum the linter enforces for each section body.

## Decision

We will do the thing for stated reasons that cover more than forty characters.

## Consequences

Listed pros and cons that constitute a body well above the minimum length.

## Alternatives considered

Other options that were investigated and rejected, written out at length.

## References

- https://example.com/source
- https://example.com/another
`;

it("ADR linter accepts a complete record", () => {
  const r = validateAdrStructure({ content: VALID });
  assert.equal(r.status, "verified");
  assert.equal(r.reason, null);
  assert.deepEqual(r.missing_sections, []);
  assert.deepEqual(r.thin_sections, []);
});

it("ADR linter flags missing Decision", () => {
  const text = VALID.replace(/## Decision[\s\S]*?(?=## Consequences)/, "");
  const r = validateAdrStructure({ content: text });
  assert.equal(r.status, "violation");
  assert.ok(r.missing_sections.includes("Decision"));
});

it("ADR linter flags missing title", () => {
  const text = VALID.replace(/^# ADR-0001: Title\n/, "# Random Heading\n");
  const r = validateAdrStructure({ content: text });
  assert.equal(r.status, "violation");
  assert.match(r.reason, /title heading/);
});

it("ADR linter accepts numbered headings", () => {
  const text = VALID
    .replace("## Status", "## 1. Status")
    .replace("## Context", "## 2. Context")
    .replace("## Decision", "## 3. Decision");
  const r = validateAdrStructure({ content: text });
  assert.equal(r.status, "verified", `unexpected violation: ${r.reason}`);
});

it("ADR linter is case-insensitive on section names", () => {
  const text = VALID.replace("## Decision", "## DECISION");
  const r = validateAdrStructure({ content: text });
  assert.equal(r.status, "verified");
});

it("ADR linter accepts MADR alias 'Considered alternatives' (P6)", () => {
  const text = VALID.replace("## Alternatives considered", "## Considered alternatives");
  const r = validateAdrStructure({ content: text });
  assert.equal(r.status, "verified", `unexpected violation: ${r.reason}`);
  assert.deepEqual(r.missing_sections, []);
});

it("ADR linter accepts bare 'Alternatives' alias (P6)", () => {
  const text = VALID.replace("## Alternatives considered", "## Alternatives");
  const r = validateAdrStructure({ content: text });
  assert.equal(r.status, "verified", `unexpected violation: ${r.reason}`);
});

it("ADR linter tolerates parenthetical note after heading (P6)", () => {
  const text = VALID.replace("## Status", "## Status (accepted 2026-05-20)");
  const r = validateAdrStructure({ content: text });
  assert.equal(r.status, "verified", `unexpected violation: ${r.reason}`);
});

it("ADR linter accepts 'Context and problem statement' alias (P6)", () => {
  const text = VALID.replace("## Context", "## Context and problem statement");
  const r = validateAdrStructure({ content: text });
  assert.equal(r.status, "verified", `unexpected violation: ${r.reason}`);
});

it("ADR linter flags thin sections", () => {
  const skeleton = `# ADR-0042: Empty bones

## Status

OK

## Context

OK

## Decision

OK

## Consequences

OK

## Alternatives considered

OK

## References

OK
`;
  const r = validateAdrStructure({ content: skeleton });
  assert.equal(r.status, "violation");
  assert.ok(r.thin_sections.length >= 1, `expected thin sections, got: ${JSON.stringify(r)}`);
});

// ─── Command allowlist ───────────────────────────────────────────────────

const TDD_HEADS = new Set(["npx", "node", "npm", "pnpm", "yarn", "bun", "python", "python3", "pytest", "go", "cargo"]);

it("allowlist accepts npx run vitest", () => {
  const { head, args } = parseAndValidateCommand("npx vitest run", { allowedHeads: TDD_HEADS });
  assert.equal(head, "npx");
  assert.deepEqual(args, ["vitest", "run"]);
});

it("allowlist rejects shell metacharacter ;", () => {
  assert.throws(
    () => parseAndValidateCommand("npx vitest; rm -rf /", { allowedHeads: TDD_HEADS }),
    err => err instanceof CommandRejectedError && /forbidden pattern/.test(err.message),
  );
});

it("allowlist rejects command substitution $()", () => {
  assert.throws(
    () => parseAndValidateCommand("npx vitest $(echo hax)", { allowedHeads: TDD_HEADS }),
    CommandRejectedError,
  );
});

it("allowlist rejects path traversal in tokens", () => {
  assert.throws(
    () => parseAndValidateCommand("npx vitest ../../etc/passwd", { allowedHeads: TDD_HEADS }),
    CommandRejectedError,
  );
});

it("allowlist rejects pipe |", () => {
  assert.throws(
    () => parseAndValidateCommand("npx vitest | tee", { allowedHeads: TDD_HEADS }),
    CommandRejectedError,
  );
});

it("allowlist rejects head not in set", () => {
  assert.throws(
    () => parseAndValidateCommand("rm -rf /tmp", { allowedHeads: TDD_HEADS }),
    err => err instanceof CommandRejectedError && /not in the allowlist/.test(err.message),
  );
});

it("tokenize handles double quotes", () => {
  assert.deepEqual(tokenize('npx vitest "a b" c'), ["npx", "vitest", "a b", "c"]);
});

it("tokenize handles single quotes", () => {
  assert.deepEqual(tokenize("npx vitest 'a b' c"), ["npx", "vitest", "a b", "c"]);
});

// ─── Path-traversal guard ────────────────────────────────────────────────

it("assertPathInProjectArtifactDir refuses paths outside .harness/<run>", () => {
  // On Windows the artifact dir is C:\proj\.harness\run_xyz, so use a
  // platform-appropriate root. The function uses path.resolve internally.
  const proj = process.platform === "win32" ? "C:\\proj" : "/proj";
  const runId = "run_test";
  assert.throws(
    () => assertPathInProjectArtifactDir(
      process.platform === "win32" ? "C:\\elsewhere\\foo.md" : "/elsewhere/foo.md",
      proj, runId,
    ),
    PathOutsideArtifactDirError,
  );
});

it("assertPathInProjectArtifactDir accepts paths under the artifact dir", () => {
  const proj = process.platform === "win32" ? "C:\\proj" : "/proj";
  const runId = "run_test";
  const inside = process.platform === "win32"
    ? "C:\\proj\\.harness\\run_test\\architecture\\adr.md"
    : "/proj/.harness/run_test/architecture/adr.md";
  const out = assertPathInProjectArtifactDir(inside, proj, runId);
  assert.ok(out.length > 0);
});

// ─── Validator policy ────────────────────────────────────────────────────

it("VALIDATOR_KINDS lists all five canonical kinds", () => {
  assert.deepEqual(
    [...VALIDATOR_KINDS].sort(),
    ["adr_structure_lint", "c4_render", "contracts_lint", "mermaid_render", "tokens_build"],
  );
});

it("requiredValidatorsForArtifact: default adr→adr_structure_lint", () => {
  assert.deepEqual(requiredValidatorsForArtifact(null, "adr"), ["adr_structure_lint"]);
});

it("requiredValidatorsForArtifact: unknown kind → []", () => {
  assert.deepEqual(requiredValidatorsForArtifact(null, "diff"), []);
});

it("requiredValidatorsForArtifact: profile additions union with defaults", () => {
  const profile = {
    name: "api-platform", description: "test",
    required_validators: { adr: ["adr_structure_lint", "contracts_lint"], openapi: ["contracts_lint"] },
  };
  const got = requiredValidatorsForArtifact(profile, "adr");
  assert.ok(got.includes("adr_structure_lint"));
  assert.ok(got.includes("contracts_lint"));
  // profile-only binding kicks in when default is absent
  assert.deepEqual(requiredValidatorsForArtifact(profile, "openapi"), ["contracts_lint"]);
});

it("requiredValidatorsForArtifact: unknown validator strings filtered out", () => {
  const profile = {
    name: "test", description: "test",
    required_validators: { adr: ["adr_structure_lint", "bogus_kind"] },
  };
  const got = requiredValidatorsForArtifact(profile, "adr");
  assert.deepEqual(got, ["adr_structure_lint"]);
});

it("strictValidators filters unknown kinds", () => {
  const profile = {
    name: "test", description: "test",
    required_validators_strict: ["mermaid_render", "bogus"],
  };
  const got = strictValidators(profile);
  assert.ok(got.has("mermaid_render"));
  assert.ok(!got.has("bogus"));
});

// ─── Judge schema compatibility ─────────────────────────────────────────────

it("buildCritiqueOutputSchema sets additionalProperties=false on every object node", () => {
  const schema = buildCritiqueOutputSchema();
  const queue = [schema];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false, `object node missing strict additionalProperties=false: ${JSON.stringify(node)}`);
    }
    if (node.properties && typeof node.properties === "object") {
      queue.push(...Object.values(node.properties));
    }
    if (node.items) queue.push(node.items);
  }
});

it("normalizeCritiqueResult converts score_entries into legacy score object", () => {
  const normalized = normalizeCritiqueResult({
    text: '{"outcome":"pass","critique_md":"Looks good","score_entries":[{"dimension":"correctness","score":0.9},{"dimension":"safety","score":0.8}]}',
  });
  assert.deepEqual(normalized.parsed, {
    outcome: "pass",
    critique_md: "Looks good",
    score: {
      correctness: 0.9,
      safety: 0.8,
    },
  });
  assert.match(normalized.text, /"score"\s*:/);
  assert.doesNotMatch(normalized.text, /score_entries/);
});

it("extractJsonValue recovers fenced JSON wrapped in prose", () => {
  const extracted = extractJsonValue(`I reviewed the artifact.

\`\`\`json
{"outcome":"pass","critique_md":"Looks good","score_entries":[{"dimension":"correctness","score":0.95}]}
\`\`\`

Verdict complete.`);
  assert.equal(extracted.found, true);
  assert.deepEqual(extracted.value, {
    outcome: "pass",
    critique_md: "Looks good",
    score_entries: [{ dimension: "correctness", score: 0.95 }],
  });
});

it("extractJsonValue recovers a top-level JSON object surrounded by prose", () => {
  const extracted = extractJsonValue('Result follows: {"outcome":"revise","critique_md":"Needs work","score":{"correctness":0.5}} Thanks.');
  assert.equal(extracted.found, true);
  assert.deepEqual(extracted.value, {
    outcome: "revise",
    critique_md: "Needs work",
    score: { correctness: 0.5 },
  });
});

it("normalizeCritiqueResult normalizes fenced verdict JSON wrapped in prose", () => {
  const normalized = normalizeCritiqueResult({
    text: `Here is the verdict:

\`\`\`json
{"outcome":"pass","critique_md":"Looks good","score_entries":[{"dimension":"correctness","score":0.9},{"dimension":"safety","score":0.8}]}
\`\`\`

Done.`,
  });
  assert.deepEqual(normalized.parsed, {
    outcome: "pass",
    critique_md: "Looks good",
    score: {
      correctness: 0.9,
      safety: 0.8,
    },
  });
});

it("normalizeCritiqueResult preserves legacy score objects", () => {
  const normalized = normalizeCritiqueResult({
    text: '{"outcome":"revise","critique_md":"Needs work","score":{"correctness":0.55,"safety":0.7}}',
  });
  assert.deepEqual(normalized.parsed, {
    outcome: "revise",
    critique_md: "Needs work",
    score: {
      correctness: 0.55,
      safety: 0.7,
    },
  });
});

it("normalizeCritiqueResult keeps invalid wrapped output unparsed", () => {
  const normalized = normalizeCritiqueResult({
    text: 'Here is a malformed block:\n```json\n{"outcome":"pass"\n```',
  });
  assert.equal(normalized.parsed, undefined);
  assert.match(normalized.text, /malformed block/);
});

it("validateCritiqueResult rejects missing verdict fields with a specific reason", () => {
  const validated = validateCritiqueResult({
    text: '{"outcome":"pass","critique_md":"Looks good"}',
  });
  assert.equal(validated.ok, false);
  assert.equal(validated.reason, "missing score");
});

it("validateCritiqueResult rejects invalid outcome values", () => {
  const validated = validateCritiqueResult({
    text: '{"outcome":"ship-it","critique_md":"Looks good","score_entries":[{"dimension":"correctness","score":0.9}]}',
  });
  assert.equal(validated.ok, false);
  assert.equal(validated.reason, "invalid outcome: ship-it");
});

await itAsync("stabilizeCritiqueResult retries exit-0 malformed critique output once before succeeding", async () => {
  let callCount = 0;
  const result = await stabilizeCritiqueResult(async () => {
    callCount++;
    if (callCount === 1) {
      return {
        text: "not json at all",
        exit_code: 0,
        wall_ms: 5,
        attempts: [{ exit_code: 0, stderr_tail: "", wall_ms: 5 }],
      };
    }
    return {
      text: '{"outcome":"revise","critique_md":"Needs one more assertion","score_entries":[{"dimension":"correctness","score":0.7}]}',
      exit_code: 0,
      wall_ms: 7,
      attempts: [{ exit_code: 0, stderr_tail: "", wall_ms: 7 }],
    };
  }, {
    cwd: mkdtempSync(join(tmpdir(), "pp-critique-bridge-")),
    vendor: "gemini",
  });

  assert.equal(callCount, 2);
  assert.equal(result.exit_code, 0);
  assert.deepEqual(result.parsed, {
    outcome: "revise",
    critique_md: "Needs one more assertion",
    score: { correctness: 0.7 },
  });
});

await itAsync("stabilizeCritiqueResult converts repeated malformed output into an archived bridge failure", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pp-critique-bridge-"));
  const result = await stabilizeCritiqueResult(async () => ({
    text: "still not json",
    exit_code: 0,
    wall_ms: 3,
    attempts: [{ exit_code: 0, stderr_tail: "", wall_ms: 3 }],
  }), {
    cwd,
    vendor: "gemini",
  });

  assert.equal(result.exit_code, 1);
  assert.equal(result.reason, "malformed JSON");
  assert.ok(result.failure_archive_path, "expected failure archive path");
  assert.ok(existsSync(result.failure_archive_path), "expected failure archive to be written");
});

it("buildCodexExecArgs includes skip-git-repo-check by default", () => {
  const cliArgs = buildCodexExecArgs({
    cwd: "C:\\proj",
    sandbox: "read-only",
    model: "gpt-5.4",
  });
  assert.ok(cliArgs.includes("--skip-git-repo-check"));
  assert.equal(cliArgs.at(-1), "-");
});

it("buildCodexExecArgs omits skip-git-repo-check when explicitly disabled", () => {
  const cliArgs = buildCodexExecArgs({
    cwd: "C:\\proj",
    sandbox: "workspace-write",
    model: "gpt-5.4",
    skip_git_repo_check: false,
  });
  assert.equal(cliArgs.includes("--skip-git-repo-check"), false);
});

it("resolveSameVendorCapability upgrades default Codex same-vendor to cross-vendor", () => {
  const capability = resolveSameVendorCapability({ generator_producer: "codex" });
  assert.equal(capability.available, false);
  assert.equal(capability.effective_generator_model, "gpt-5.4");
  assert.equal(capability.inferred_generator_model, true);
  assert.equal(capability.judge_model_id, "gpt-5.4");
  assert.match(capability.reason, /hard-pinned/);
});

it("resolveSameVendorCapability allows Codex same-vendor when generator model differs", () => {
  const capability = resolveSameVendorCapability({
    generator_producer: "codex",
    generator_model: "gpt-5.5",
  });
  assert.equal(capability.available, true);
  assert.equal(capability.effective_generator_model, "gpt-5.5");
  assert.equal(capability.inferred_generator_model, false);
  assert.equal(capability.judge_model_id, "gpt-5.4");
  assert.equal(capability.reason, null);
});

it("describeJudgeCapabilities reports Codex as conditional and Gemini as degenerate", () => {
  const caps = describeJudgeCapabilities();
  assert.equal(caps.codex.same_vendor_mode, "conditional_cross_vendor");
  assert.deepEqual(caps.codex.unavailable_when_generator_model_is, ["gpt-5.4"]);
  assert.equal(caps.gemini.same_vendor_mode, "degenerate_same_model_allowed");
});

it("parseCodexJsonl extracts item.completed agent_message text payloads", () => {
  const parsed = parseCodexJsonl(
    '{"type":"thread.started","thread_id":"abc"}\n' +
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"outcome\\":\\"pass\\",\\"critique_md\\":\\"Looks good\\",\\"score_entries\\":[{\\"dimension\\":\\"correctness\\",\\"score\\":0.9}]}"}}\n' +
    '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":34}}\n'
  );

  assert.equal(parsed.tokens_in, 12);
  assert.equal(parsed.tokens_out, 34);
  assert.equal(parsed.text, '{"outcome":"pass","critique_md":"Looks good","score_entries":[{"dimension":"correctness","score":0.9}]}');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
