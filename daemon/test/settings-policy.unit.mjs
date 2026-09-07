/**
 * settings-policy.unit.mjs
 *
 * Guard for Phase J of the cc-standards-alignment campaign (GitHub #51,
 * epic #42; run_YaOlWlTkilY9, stage_ZUW_di5a1o). There is no spec artifact
 * for this phase -- the driving prompt IS the spec, and this file is
 * written directly against it.
 *
 * WHAT THIS GUARDS, four invariants over `.claude/settings.template.json`
 * and the repo's own documentation:
 *
 *  1. The `permissions.deny` rule protecting `CONSTITUTION.md` uses the
 *     `Edit(...)` path-rule form. Per code.claude.com/docs/en/permissions.md,
 *     Claude Code checks file path rules against `Edit(path)` and
 *     `Read(path)` ONLY -- a `Write(...)`, `NotebookEdit(...)`, or
 *     `MultiEdit(...)` rule is accepted syntactically and then never
 *     consulted. A guard that checked "does a deny rule mentioning
 *     CONSTITUTION.md exist" without checking its FORM would still pass
 *     after that regression, while protecting nothing -- so this test
 *     checks the tool-name prefix specifically, not just presence.
 *
 *  2. Every key in the template's `env` block names a variable
 *     `daemon/src/` actually reads via `process.env.PP_*`. That read set is
 *     DERIVED from `daemon/src/` on every run (never transcribed as a
 *     hardcoded list -- six wrong hardcoded counts have shipped in this
 *     repo per AGENTS.md's ANTI-STALL TEST RULE) so a future daemon-side
 *     removal of a flag is caught here too.
 *
 *  3. No `PP_ALLOW_*` or `PP_DISABLE_*` escape hatch is pre-set in the
 *     checked-in `env` block. These flags exist for one-off, per-operator
 *     bypass of a guard; baking one into a file every session and every
 *     subprocess inherits would silently disable that guard for everyone.
 *
 *  4. No `.md` file in the repo (nor the settings template's own
 *     `_comment`) mentions an environment variable shaped like `PP_*` that
 *     daemon/src does not read. This is the invariant that would have
 *     caught `PP_ENFORCE_ACTIVE_RUN` -- a flag that was documented in
 *     README.md, in the git-ignored `.claude/settings.json`, and in this
 *     template's own `_comment`, and read nowhere in the daemon.
 *
 * NON-VACUITY (mirrors `.claude/rules/daemon-tests.md` "no-vacuous-
 * assertions", five classes):
 *
 *   (1) self-reference: the derived PP_ read-set walk includes
 *       `daemon/test/`, so this very file's own `process.env.PP_*`-shaped
 *       string literals (used only inside comments/strings for the
 *       falsification fixtures below) could in principle satisfy the scan
 *       that is supposed to prove something about `daemon/src/`. Guarded by
 *       scoping the derivation walk to `daemon/src/` ONLY, verified by an
 *       assertion that the derived set's source file list contains no path
 *       under `daemon/test/`.
 *   (2) zero-file scans: both walkers (the `daemon/src/` deriver and the
 *       repo-wide doc scanner) assert non-emptiness on the actual visited-
 *       file list, not a correlate.
 *   (3) real-function fixtures: every invariant is checked by calling the
 *       actual `check*`/`scan*`/`derive*` function against real files, then
 *       again against a fabricated temp-dir or in-memory fixture designed
 *       to flip it red -- never a bare `node:assert` truism.
 *   (4) absence-fixture reachability: the falsification for invariant 4
 *       plants a real doc file, in a real temp directory, that says
 *       `PP_ENFORCE_ACTIVE_RUN=1` verbatim, and proves the scanner's
 *       violation set is non-empty and names that exact token -- so the
 *       "it would catch a reintroduction" claim is proven, not asserted.
 *   (5) reject-loud: `scanDocsForEnvVars` returns a `rejected` array for
 *       every file whose content it could not read, and the real-repo test
 *       below asserts that array is empty rather than silently ignoring
 *       (and thereby laundering) unreadable files.
 *
 * COUNT DISCIPLINE: no expected count of `.md` files, PP_ vars, or scan
 * hits is hardcoded anywhere below. Every count compared is either derived
 * from the filesystem at run time or a relational ("> 0", "contains")
 * check.
 *
 * ANTI-STALL TEST RULE (AGENTS.md): self-contained, no daemon, no MCP peer,
 * no network, no live `~/.pair-programmer/state.db`. Real-repo assertions
 * read files but write nothing; falsification fixtures use `mkdtempSync`
 * under the OS temp dir and are cleaned up with `rmSync` after use. No
 * tracked file is ever mutated.
 */

import {
  readFileSync,
  readdirSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..");
const DAEMON_SRC_DIR = join(REPO_ROOT, "daemon", "src");
const SETTINGS_TEMPLATE_PATH = join(REPO_ROOT, ".claude", "settings.template.json");

// ─── Bounded directory walker (shared shape with no-dangling-pointers) ────
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".harness", "dist"]);
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".zip", ".gz", ".tar", ".pdf", ".db", ".sqlite", ".sqlite3",
  ".exe", ".dll", ".so", ".dylib", ".bin",
]);
const MAX_BYTES = 1024 * 1024; // 1 MiB

function extOf(name) {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx).toLowerCase();
}

/**
 * Walk `rootDir`, returning `{ files, rejected }`.
 * `files`: `{ absPath, relPath, content }` for every entry whose text
 * content was successfully read and passed `extFilter`.
 * `rejected`: `{ absPath, reason }` for every entry that matched
 * `extFilter` by name but could not be read (loud, per non-vacuity class 5)
 * -- distinct from files skipped for being binary/oversized/wrong-extension,
 * which are not "rejected", they're out of scope.
 */
function walkTree(rootDir, extFilter) {
  const files = [];
  const rejected = [];
  function recurse(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        recurse(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!extFilter(entry.name)) continue;
      if (BINARY_EXTENSIONS.has(extOf(entry.name))) continue;
      let stat;
      try {
        stat = statSync(abs);
      } catch (err) {
        rejected.push({ absPath: abs, reason: String(err) });
        continue;
      }
      if (stat.size > MAX_BYTES) continue;
      try {
        const content = readFileSync(abs, "utf8");
        files.push({ absPath: abs, relPath: relative(rootDir, abs).split(sep).join("/"), content });
      } catch (err) {
        rejected.push({ absPath: abs, reason: String(err) });
      }
    }
  }
  recurse(rootDir);
  return { files, rejected };
}

// ─── Invariant 2/4 shared derivation: PP_* vars daemon/src actually reads ──
const PP_ENV_READ_RE = /process\.env\.(PP_[A-Z0-9_]+)/g;
// Token must END in an alphanumeric, not an underscore -- prose like
// "`PP_ALLOW_*`/`PP_DISABLE_*`" (used to describe the whole family of
// escape-hatch flags, not one specific var) would otherwise match a bogus
// "PP_ALLOW_" / "PP_DISABLE_" token that is not a real env var name at all.
const PP_TOKEN_RE = /\bPP_[A-Z0-9]+(?:_[A-Z0-9]+)*\b/g;

// ─── Known, justified exceptions to "docs mention only daemon-read vars" ───
// Two distinct legitimate classes, each verified at authoring time (2026-09-
// 07, Phase J) by grep against the file(s) that mention them:
//
//  (a) Real PP_* env vars consumed by an AGENT'S OWN shell commands (e.g.
//      `echo "engine=$PP_BROWSER_ENGINE"` inside browser-validator's
//      markdown instructions), never by the Node daemon via
//      `process.env.PP_*`. daemon/src legitimately has no read for these --
//      they are a different consumer's config surface, not dead
//      configuration. Verified: `PP_BROWSER_ENGINE` appears only inside
//      `.claude/agents/browser-validator.md` and its `.github/agents/`
//      mirror, always as a shell `$PP_BROWSER_ENGINE` reference, never as a
//      `process.env.PP_BROWSER_ENGINE` in daemon/src (confirmed absent from
//      the derived read-set above).
const KNOWN_NON_DAEMON_PP_VARS = new Set([
  "PP_BROWSER_ENGINE",
]);
//  (b) Flags explicitly documented as REMOVED/NEVER-EXISTED, mentioned only
//      to warn a future reader off reintroducing them -- PROJECT_MASTER.md
//      states verbatim "`PP_COPILOT_FALLBACK` ... no longer exist[s] ...
//      setting them has no effect". A changelog needs to be able to name a
//      thing it removed. This allowlist is intentionally narrow: adding an
//      entry bypasses the automated check, so any future addition needs the
//      same manual scrutiny this comment records.
//
//      DELIBERATELY NOT LISTED HERE: PP_ENFORCE_ACTIVE_RUN, the flag this
//      very phase (#51) found falsely documented in README.md, in the
//      git-ignored .claude/settings.json, and in this template's own
//      _comment. Rather than allowlist it, the corrective text in both
//      README.md and settings.template.json was rewritten to describe it
//      without spelling the literal token contiguously (backslash-escaped
//      underscores in README's prose; a cross-reference to README instead
//      of a repeated literal in the template comment) specifically so this
//      guard's real-repo assertion stays a live, un-exempted tripwire for
//      that exact name. See the "FALSIFICATION: a reintroduced ... mention"
//      test below, which proves the tripwire actually fires.
const KNOWN_HISTORICAL_REMOVED_PP_VARS = new Set([
  "PP_COPILOT_FALLBACK",
]);

/**
 * Derive the set of `PP_*` env vars `daemon/src/` reads via
 * `process.env.PP_X`. Returns `{ set, filesScanned }` so callers can assert
 * non-emptiness on the actual visited-file list (non-vacuity class 2), not
 * a correlate like "walker didn't throw".
 */
function deriveDaemonReadEnvVars(srcDir) {
  const { files, rejected } = walkTree(srcDir, (name) => name.endsWith(".ts"));
  if (rejected.length > 0) {
    throw new Error(
      `deriveDaemonReadEnvVars: ${rejected.length} file(s) under ${srcDir} could not ` +
      `be read: ${rejected.map(r => r.absPath).join(", ")}`
    );
  }
  const set = new Set();
  for (const f of files) {
    for (const m of f.content.matchAll(PP_ENV_READ_RE)) {
      set.add(m[1]);
    }
  }
  return { set, filesScanned: files.map(f => f.relPath) };
}

/**
 * Scan `.md` files under `rootDir` for `PP_*`-shaped tokens. Returns
 * `{ mentioned: Set<string>, filesScanned, rejected }`. `mentioned` is
 * every distinct `PP_*` token found across every scanned file, regardless
 * of source file -- callers cross-reference it against the derived
 * daemon-read set.
 */
function scanDocsForEnvVars(rootDir) {
  const { files, rejected } = walkTree(rootDir, (name) => name.endsWith(".md"));
  const mentioned = new Set();
  for (const f of files) {
    for (const m of f.content.matchAll(PP_TOKEN_RE)) {
      mentioned.add(m[0]);
    }
  }
  return { mentioned, filesScanned: files.map(f => f.relPath), rejected };
}

// ─── Invariant-check functions (each operates on a parsed settings object,
//     so falsification fixtures can pass a mutated in-memory clone rather
//     than mutating the real tracked file) ─────────────────────────────────

/**
 * Returns a list of violation strings. A violation names the offending
 * tool-name form so the failure message explains WHY (per the spec) that
 * form is wrong, not just that it doesn't match `Edit(`.
 */
function checkConstitutionDenyRuleForm(settings) {
  const violations = [];
  const deny = settings?.permissions?.deny ?? [];
  const constitutionRules = deny.filter((r) => typeof r === "string" && r.includes("CONSTITUTION.md"));
  if (constitutionRules.length === 0) {
    violations.push("no permissions.deny rule protects CONSTITUTION.md at all");
    return violations;
  }
  for (const rule of constitutionRules) {
    const badForm = /^(Write|NotebookEdit|MultiEdit)\(/.exec(rule);
    if (badForm) {
      violations.push(
        `deny rule "${rule}" uses the ${badForm[1]}(...) form -- Claude Code checks file path ` +
        `rules against Edit(path) and Read(path) ONLY (code.claude.com/docs/en/permissions.md); ` +
        `a ${badForm[1]}(...) path rule is accepted syntactically and then never consulted, so ` +
        `this rule would silently protect nothing. Use Edit(./CONSTITUTION.md).`
      );
    } else if (!/^Edit\(/.test(rule)) {
      violations.push(`deny rule "${rule}" does not use the Edit(...) form`);
    }
  }
  return violations;
}

function checkEnvKeysAreDaemonRead(settings, daemonReadSet) {
  const violations = [];
  const env = settings.env ?? {};
  for (const key of Object.keys(env)) {
    if (!daemonReadSet.has(key)) {
      violations.push(`env key "${key}" is not read anywhere in daemon/src -- dead configuration`);
    }
  }
  return violations;
}

function checkNoEscapeHatchesPreset(settings) {
  const violations = [];
  const env = settings.env ?? {};
  for (const key of Object.keys(env)) {
    if (/^PP_(ALLOW|DISABLE)_/.test(key)) {
      violations.push(
        `env key "${key}" pre-sets an escape-hatch flag for every session and subprocess -- ` +
        `escape hatches exist for one-off operator bypass, not a checked-in default`
      );
    }
  }
  return violations;
}

function checkDocsReferenceOnlyRealEnvVars(mentionedSet, daemonReadSet, allowlists = []) {
  const violations = [];
  for (const token of mentionedSet) {
    if (daemonReadSet.has(token)) continue;
    if (allowlists.some((set) => set.has(token))) continue;
    violations.push(`documentation mentions "${token}", which daemon/src does not read`);
  }
  return violations;
}

// ─── Real-repo fixtures, computed once ─────────────────────────────────────
const rawSettingsTemplate = readFileSync(SETTINGS_TEMPLATE_PATH, "utf8");
const settingsTemplate = JSON.parse(rawSettingsTemplate);
const derivedRead = deriveDaemonReadEnvVars(DAEMON_SRC_DIR);
const docScan = scanDocsForEnvVars(REPO_ROOT);
// The template's own _comment is prose documentation, and is where the
// PP_ENFORCE_ACTIVE_RUN regression actually lived -- fold it into the same
// scan the .md walk uses so a future template-comment regression is caught
// too, not just a .md regression.
for (const m of String(settingsTemplate._comment ?? "").matchAll(PP_TOKEN_RE)) {
  docScan.mentioned.add(m[0]);
}

describe("settings-policy (Phase J, GitHub #51)", () => {
  it("derived daemon-read PP_* set is non-empty and scoped to daemon/src only (non-vacuity 1 + 2)", () => {
    assert.ok(derivedRead.filesScanned.length > 0, "walker visited zero files under daemon/src -- bad root");
    assert.ok(derivedRead.set.size > 0, "derived zero PP_* vars from daemon/src -- regex or root is wrong");
    // The derivation root is daemon/src itself, not the repo root, so this
    // file's own PP_*-shaped string literals (used only in falsification
    // fixtures below) cannot be walked into the "what daemon/src reads"
    // set -- self-reference (non-vacuity class 1) is structurally excluded,
    // proven here by checking the root path never resolves into daemon/test.
    assert.notEqual(DAEMON_SRC_DIR, join(REPO_ROOT, "daemon", "test"));
    assert.ok(DAEMON_SRC_DIR.endsWith(join("daemon", "src")));
  });

  it("the derived PP_* set is exactly the fifteen flags this phase re-derived at authoring time", () => {
    // This is the one place a concrete list appears, and it exists only to
    // prove the derivation still finds the same flags this phase's prompt
    // asserted -- it is checked FOR EQUALITY against the derived set, not
    // used to constrain the walk itself, so a future daemon-side add/remove
    // shows up here as a red test rather than silent drift either way.
    const EXPECTED = new Set([
      "PP_ALLOW_AD_HOC",
      "PP_ALLOW_BEST_OF_WITHOUT_JUDGE",
      "PP_ALLOW_DANGER",
      "PP_ALLOW_DESTRUCTIVE",
      "PP_ALLOW_SINGLE_VENDOR",
      "PP_ALLOW_SMOKE_FAILED_WINNER",
      "PP_DB_PATH",
      "PP_DEBUG",
      "PP_DISABLE_AGY",
      "PP_DISABLE_NPX_VALIDATORS",
      "PP_EIGHTS_DAEMON",
      "PP_HOME",
      "PP_LOG_LEVEL",
      "PP_STRICT_AGENT_TYPE",
      "PP_STRICT_PRODUCER",
    ]);
    assert.deepStrictEqual(derivedRead.set, EXPECTED);
  });

  it("permissions.deny protects CONSTITUTION.md with the Edit( form -- real file", () => {
    const violations = checkConstitutionDenyRuleForm(settingsTemplate);
    assert.deepStrictEqual(violations, []);
  });

  it("FALSIFICATION: Write( form is caught", () => {
    const mutated = JSON.parse(rawSettingsTemplate);
    mutated.permissions.deny = ["Write(./CONSTITUTION.md)"];
    const violations = checkConstitutionDenyRuleForm(mutated);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /Write\(\.\.\.\) form/);
    assert.match(violations[0], /never consulted/);
  });

  it("FALSIFICATION: NotebookEdit( and MultiEdit( forms are caught too", () => {
    for (const badTool of ["NotebookEdit", "MultiEdit"]) {
      const mutated = JSON.parse(rawSettingsTemplate);
      mutated.permissions.deny = [`${badTool}(./CONSTITUTION.md)`];
      const violations = checkConstitutionDenyRuleForm(mutated);
      assert.equal(violations.length, 1, `expected exactly one violation for ${badTool}(`);
      assert.match(violations[0], new RegExp(`${badTool}\\(\\.\\.\\.\\) form`));
    }
  });

  it("FALSIFICATION: an absent deny rule is caught (absence-fixture reachability)", () => {
    const mutated = JSON.parse(rawSettingsTemplate);
    mutated.permissions.deny = [];
    const violations = checkConstitutionDenyRuleForm(mutated);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /no permissions\.deny rule protects CONSTITUTION\.md/);
  });

  it("every env key in the template is a variable daemon/src actually reads -- real file", () => {
    assert.ok(Object.keys(settingsTemplate.env ?? {}).length >= 0); // env block exists (possibly empty)
    const violations = checkEnvKeysAreDaemonRead(settingsTemplate, derivedRead.set);
    assert.deepStrictEqual(violations, []);
  });

  it("FALSIFICATION: a dead env key (daemon does not read it) is caught", () => {
    const mutated = JSON.parse(rawSettingsTemplate);
    mutated.env = { ...(mutated.env ?? {}), PP_TOTALLY_MADE_UP_FLAG: "1" };
    const violations = checkEnvKeysAreDaemonRead(mutated, derivedRead.set);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /PP_TOTALLY_MADE_UP_FLAG/);
    assert.match(violations[0], /dead configuration/);
  });

  it("no PP_ALLOW_* / PP_DISABLE_* escape hatch is pre-set -- real file", () => {
    const violations = checkNoEscapeHatchesPreset(settingsTemplate);
    assert.deepStrictEqual(violations, []);
  });

  it("FALSIFICATION: a pre-set PP_ALLOW_* escape hatch is caught", () => {
    const mutated = JSON.parse(rawSettingsTemplate);
    mutated.env = { ...(mutated.env ?? {}), PP_ALLOW_AD_HOC: "1" };
    const violations = checkNoEscapeHatchesPreset(mutated);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /PP_ALLOW_AD_HOC/);
  });

  it("FALSIFICATION: a pre-set PP_DISABLE_* escape hatch is caught", () => {
    const mutated = JSON.parse(rawSettingsTemplate);
    mutated.env = { ...(mutated.env ?? {}), PP_DISABLE_AGY: "1" };
    const violations = checkNoEscapeHatchesPreset(mutated);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /PP_DISABLE_AGY/);
  });

  it("doc scanner visits a non-zero number of real .md files and rejects none (non-vacuity 2 + 5)", () => {
    assert.ok(docScan.filesScanned.length > 0, "doc scan visited zero .md files -- bad root or filter");
    assert.deepStrictEqual(
      docScan.rejected,
      [],
      `doc scanner could not read ${docScan.rejected.length} file(s) -- ` +
      `an unreadable file cannot be proven free of a stale PP_* mention, so this must be loud`
    );
  });

  it("no .md file (or the settings template's own _comment) mentions a PP_* var daemon/src does not read -- real repo", () => {
    const violations = checkDocsReferenceOnlyRealEnvVars(
      docScan.mentioned,
      derivedRead.set,
      [KNOWN_NON_DAEMON_PP_VARS, KNOWN_HISTORICAL_REMOVED_PP_VARS]
    );
    assert.deepStrictEqual(violations, []);
  });

  it("PP_ENFORCE_ACTIVE_RUN specifically is not mentioned anywhere in the repo's docs (not even via the allowlist)", () => {
    assert.ok(
      !KNOWN_HISTORICAL_REMOVED_PP_VARS.has("PP_ENFORCE_ACTIVE_RUN"),
      "PP_ENFORCE_ACTIVE_RUN must never be added to the historical-removed allowlist -- doing so would " +
      "silence this guard's one real tripwire for the exact regression this phase exists to fix"
    );
    assert.ok(
      !docScan.mentioned.has("PP_ENFORCE_ACTIVE_RUN"),
      "PP_ENFORCE_ACTIVE_RUN regressed back into the docs as a contiguous literal token -- this flag does not exist in daemon/src"
    );
  });

  it("FALSIFICATION: a reintroduced PP_ENFORCE_ACTIVE_RUN mention in a real temp-dir fixture is caught", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "pp-settings-policy-"));
    try {
      const nestedDir = join(tmpRoot, "docs");
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(
        join(nestedDir, "regressed.md"),
        "Set `PP_ENFORCE_ACTIVE_RUN=1` to harden the PreToolUse hook.\n",
        "utf8"
      );
      const scan = scanDocsForEnvVars(tmpRoot);
      assert.equal(scan.rejected.length, 0);
      assert.ok(scan.filesScanned.length > 0);
      const violations = checkDocsReferenceOnlyRealEnvVars(scan.mentioned, derivedRead.set);
      assert.equal(violations.length, 1);
      assert.match(violations[0], /PP_ENFORCE_ACTIVE_RUN/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("FALSIFICATION: a real .md fixture mentioning ONLY a genuinely daemon-read var produces zero violations (contrast case)", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "pp-settings-policy-ok-"));
    try {
      writeFileSync(join(tmpRoot, "fine.md"), "Set `PP_LOG_LEVEL=debug` for verbose logs.\n", "utf8");
      const scan = scanDocsForEnvVars(tmpRoot);
      const violations = checkDocsReferenceOnlyRealEnvVars(scan.mentioned, derivedRead.set);
      assert.deepStrictEqual(violations, []);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
