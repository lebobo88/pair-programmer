// pointer-file.mjs
//
// Single shared definition of "pointer file" for scripts/sync-copilot-assets.mjs
// (R6.2, cc-standards-alignment Phase F). A pointer file is a stub left behind
// when `.claude/agents/` or `.claude/skills/` carried an overlay materialised
// (on a checkout without symlink support) as a plain file whose entire content
// is a single absolute path into a sibling deployment checkout. Reading one as
// a source and writing its bare path into a generated mirror is the defect
// documented at daemon/test/no-dangling-pointers.unit.mjs:7-16 — silent data
// loss, observed for real as ~673 deleted lines across nine mirrors.
//
// R6.2 requires the predicate live in exactly one place, imported by both the
// generator and its test coverage, rather than existing as two definitions
// that can drift apart. This module is that one place. The definition below
// is copied verbatim (not reimplemented) from
// daemon/test/no-dangling-pointers.unit.mjs's isPointerFile/WIN_ABS_RE/POSIX_ABS_RE,
// which is Phase E's already-shipped, already-tested definition.
//
// Definition — pointer file:
//   1. strip a UTF-8 BOM, normalise CRLF -> LF, trim leading/trailing whitespace
//   2. remaining content has no LF (exactly one line)
//   3. does not begin with `---` (no frontmatter opener)
//   4. matches an absolute-path shape (Windows drive-letter or POSIX), with no
//      interior whitespace anywhere in the remaining content

// A Windows drive-letter absolute path: `C:\...` or `C:/...`, single line, no
// whitespace anywhere in what remains after trim.
const WIN_ABS_RE = /^[A-Za-z]:[\\/]\S*$/;
// A POSIX absolute path: `/...`, same constraints.
const POSIX_ABS_RE = /^\/\S+$/;

export function isPointerFile(rawContent) {
  let s = rawContent;
  if (s.length > 0 && s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/\r\n/g, "\n");
  s = s.trim();
  if (s.length === 0) return false;
  if (s.includes("\n")) return false;
  if (s.startsWith("---")) return false;
  return WIN_ABS_RE.test(s) || POSIX_ABS_RE.test(s);
}
