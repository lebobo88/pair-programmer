---
paths:
  - "daemon/test/**/*.mjs"
---

# Test rules for `daemon/test/**`

**This is a Claude-only mirror of the ANTI-STALL TEST RULE in `AGENTS.md`, not a replacement for it.**
`AGENTS.md` is the cross-tool contract — Codex, Antigravity (agy) and Copilot read it and do **not** read
`.claude/rules/`. Claude Code reads `CLAUDE.md`, not `AGENTS.md`, and gets `AGENTS.md` through the
`@AGENTS.md` import at the top of `CLAUDE.md`. So the rule below is already in context from that import; this
file exists to put it in front of you *again*, with the file-specific detail, at the moment you are actually
working in this directory. **If the two ever disagree, `AGENTS.md` wins.**

## ANTI-STALL TEST RULE

*Mirror of `### ANTI-STALL TEST RULE (critical)` in `AGENTS.md`.*

`daemon/test/<name>.unit.mjs`: temp SQLite, direct imports from `dist/`, **no live daemon, no MCP peer, no
network**. Fast and deterministic.

```
node --test --test-timeout=60000 daemon/test/<name>.unit.mjs
```

**Never open or migrate the live `~/.pair-programmer/state.db` from a test.** Use a temp database. Phase H of
the cc-standards-alignment campaign lost its own v10 migration test subject because a background daemon
opened the live file first.

## The full-suite timeout is 180000, and it is a moving target

*Mirror of `### ANTI-STALL TEST RULE (critical)` in `AGENTS.md` — the same rule, split here for readability.*

```
node --test --test-timeout=180000 daemon/test/*.unit.mjs
```

`node --test` runs files concurrently, `finalize-gates-a.unit.mjs` takes ~26–33 s alone, and the ceiling is a
function of **total parallel load, not of any one file**. History, because it will move again: 60 s failed and
120 s passed (GitHub #57); then 120 s failed once the campaign added ten suites, and 180 s passed. **If you
add suites and the sweep goes red, check this before assuming you broke something.**

**The failure mode is the dangerous part.** It surfaces as a bare `'test failed'` at `:1:1` with *no
assertion text*, which is indistinguishable from a real regression. Two signatures tell them apart:

- bare `'test failed'` at `:1:1`, and the file passes alone at 60 s → the #57 flake;
- a named assertion → yours.

60 s remains correct for a single file.

## Prefer `*.unit.mjs` over `npm test` in automated contexts

*Mirror of `### ANTI-STALL TEST RULE (critical)` in `AGENTS.md`.*

`npm test` pulls in `eights-integration.smoke.mjs` (needs an external TheEights peer) and `smoke.mjs` (spawns
a daemon). Its unit portion is the glob `node --test --test-timeout=180000 test/*.unit.mjs`, so a new
`*.unit.mjs` file is picked up automatically. **Do not reintroduce an explicit filename list** — the previous
one silently drifted to 32 of 52 files, omitting three guards that had been declared must-run-in-CI.

## no-vacuous-assertions

*Mirror of `### no-vacuous-assertions` in `AGENTS.md`.*

Five classes have shipped in this repo and been caught by a cross-vendor judge. Every one of them passed a
review first.

1. **An assertion whose own source satisfies the pattern it searches for.** Assemble forbidden literals at
   runtime from fragments, and self-check `__filename`. See `no-dangling-pointers.unit.mjs` and
   `skill-discovery.unit.mjs` for the working shape.
2. **A scan that visits zero files and passes.** Assert non-emptiness on **the collection actually
   iterated**, never on a correlate. One shipped assertion guarded a counter incremented *before* the filters
   while the assertions iterated the post-filter list.
3. **A fixture that exercises `node:assert` rather than the function under test.** `assert.ok(0 > 0)` on a
   hand-built empty `Set` shipped once. Drive the real function.
4. **An absence assertion whose fixture cannot produce the condition denied.** A `node_modules` skip check
   scanned two roots that contain none.
5. **A filter or parser that silently discards exactly the inputs the assertion exists to find.** The worst
   of the five, because it satisfies all the others. A frontmatter parser dropped the malformed lines it
   existed to catch and reported zero violations. **If you filter or parse a population, assert on what you
   rejected too** — "nothing survived" and "nothing needed to" must be distinguishable outcomes, and a
   falsifiability fixture whose input the filter drops proves nothing.

**Derive every count from the filesystem or the database. Six wrong hardcoded counts have shipped here.**

**Every positive invariant needs a falsifiability proof** — a mutation that turns it red — via a
temp-directory or in-memory fixture. **Never mutate a real tracked file from inside the suite.** If you must
mutate one out of band, verify it byte-identical afterward with a checksum, and do **not** use
`git checkout --` to revert it: that discards uncommitted work, which has already happened once.

## Deleting a test needs a replacement in the same commit

*Mirror of Hard Rule 8 in `AGENTS.md`.*

`CONSTITUTION.md` FORBIDDEN-3. **No automated guard enforces this** — it is a review obligation, so the
replacement and the reason belong in the commit message where a reviewer will see them.
