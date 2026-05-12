// Unit tests for artifact-validator helpers. No subprocess, no MCP.
// Exercises pure code paths: ADR structure linter, command allowlist
// tokenizer / forbidden-pattern rejection, path-traversal refusal,
// validator-policy resolver.

import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

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
  normalizeCritiqueResult,
} = await import(pathToFileURL(join(__dirname, "..", "dist", "mcp", "critique-schema.js")).href);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
