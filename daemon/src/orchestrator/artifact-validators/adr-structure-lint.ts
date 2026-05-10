/**
 * ADR (Architecture Decision Record) structure linter.
 *
 * Pure regex / in-process. Verifies that an architect-produced ADR
 * markdown file has the 6 mandatory MADR/Nygard sections plus an
 * `# ADR-NNNN` title heading. Sections are matched case-insensitively
 * and tolerate optional numeric prefixes (`## 1. Status`, `### Status`).
 *
 * The check is intentionally conservative: it enforces SHAPE, not
 * semantic quality. The judge LLM still scores Decision-fitness etc.;
 * this gate only catches ADRs that are missing structure outright.
 */

const REQUIRED_SECTIONS = [
  "Status",
  "Context",
  "Decision",
  "Consequences",
  "Alternatives considered",
  "References",
] as const;

const ADR_TITLE_RE = /^#\s+ADR[-\s]?\d{2,4}\b/im;
const HEADING_RE = /^(#{1,6})\s+(?:\d+\.\s*)?(.+?)\s*$/gm;

const MIN_SECTION_BODY = 40;

export type AdrLintResult = {
  status: "verified" | "violation";
  reason: string | null;
  missing_sections?: string[];
  thin_sections?: string[];
  has_title?: boolean;
};

export function validateAdrStructure(input: { content: string }): AdrLintResult {
  const text = input.content;

  const hasTitle = ADR_TITLE_RE.test(text);

  const headings: Array<{ level: number; title: string; offset: number }> = [];
  for (const m of text.matchAll(HEADING_RE)) {
    headings.push({
      level: m[1]!.length,
      title: m[2]!.trim(),
      offset: m.index ?? 0,
    });
  }

  const found = new Map<string, { offset: number; bodyStart: number }>();
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]!;
    const matched = REQUIRED_SECTIONS.find(
      s => s.toLowerCase() === h.title.toLowerCase(),
    );
    if (matched && !found.has(matched)) {
      const next = headings[i + 1];
      const bodyStart = h.offset + (text.slice(h.offset).match(/\r?\n/)?.index ?? 0) + 1;
      found.set(matched, { offset: h.offset, bodyStart });
      const _ = next;
    }
  }

  const missing = REQUIRED_SECTIONS.filter(s => !found.has(s));

  // Body-thinness check: between each section heading and the next heading
  // (of equal-or-greater level, OR end of text), the trimmed body must be
  // at least MIN_SECTION_BODY chars. Stops "Status\n## Context\n## Decision\n…"
  // skeletons from passing.
  const thin: string[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]!;
    const matched = REQUIRED_SECTIONS.find(
      s => s.toLowerCase() === h.title.toLowerCase(),
    );
    if (!matched) continue;
    let end = text.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j]!.level <= h.level) { end = headings[j]!.offset; break; }
    }
    const body = text
      .slice(h.offset + (text.slice(h.offset).match(/\r?\n/)?.index ?? 0) + 1, end)
      .replace(/\s+/g, " ")
      .trim();
    if (body.length < MIN_SECTION_BODY && !thin.includes(matched)) thin.push(matched);
  }

  const problems: string[] = [];
  if (!hasTitle) problems.push("missing ADR-NNNN title heading (e.g. '# ADR-0007: Adopt SQLite for local state')");
  if (missing.length > 0) problems.push(`missing sections: ${missing.join(", ")}`);
  if (thin.length > 0) problems.push(`thin sections (<${MIN_SECTION_BODY} chars body): ${thin.join(", ")}`);

  if (problems.length === 0) {
    return { status: "verified", reason: null, has_title: true, missing_sections: [], thin_sections: [] };
  }
  return {
    status: "violation",
    reason: problems.join("; "),
    has_title: hasTitle,
    missing_sections: missing,
    thin_sections: thin,
  };
}
