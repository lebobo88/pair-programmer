type JsonObject = Record<string, unknown>;
export type CritiqueOutcome = "pass" | "fail" | "revise";

export type FindingProvenance = {
  id: string;
  file: string;
  line: number;
  quoted_text: string;
  claim: string;
};

export type CritiqueVerdict = {
  outcome: CritiqueOutcome;
  critique_md: string;
  score: Record<string, number>;
  findings_provenance?: FindingProvenance[];
};

type ExtractedJson =
  | { found: false }
  | { found: true; value: unknown };

export function buildCritiqueOutputSchema(): JsonObject {
  return {
    type: "object",
    properties: {
      outcome: {
        type: "string",
        enum: ["pass", "fail", "revise"],
      },
      critique_md: { type: "string" },
      score_entries: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            dimension: { type: "string" },
            score: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["dimension", "score"],
          additionalProperties: false,
        },
      },
      // OpenAI strict structured-output mode (engaged by `codex --output-schema`)
      // requires `required` to enumerate EVERY key in `properties`. An optional
      // field is therefore expressed as nullable-and-required, NOT by omission from
      // `required`. Removing findings_provenance from `required` below returns a 400
      // invalid_json_schema and takes the entire codex judge lane offline — that
      // regression shipped once already (run_jc1UxeCMvyZR) and was caught only by a
      // live round-trip, because unit tests inspect this object without sending it.
      findings_provenance: {
        type: ["array", "null"],
        items: {
          type: "object",
          properties: {
            id:           { type: "string" },
            file:         { type: "string" },
            line:         { type: "integer", minimum: 1 },
            quoted_text:  { type: "string", minLength: 8 },
            claim:        { type: "string" },
          },
          required: ["id", "file", "line", "quoted_text", "claim"],
          additionalProperties: false,
        },
      },
    },
    required: ["outcome", "critique_md", "score_entries", "findings_provenance"],
    additionalProperties: false,
  };
}

export function normalizeCritiqueResult<T extends { text: string; parsed?: unknown }>(result: T): T {
  const validated = validateCritiqueResult(result);
  if (!validated.ok) return result;
  return {
    ...result,
    text: JSON.stringify(validated.verdict, null, 2),
    parsed: validated.verdict,
  };
}

export function validateCritiqueResult(input: { text: string; parsed?: unknown }):
  | { ok: true; verdict: CritiqueVerdict }
  | { ok: false; reason: string } {
  if (!input.text.trim()) return { ok: false, reason: "empty output" };

  const extracted = extractJsonValue(input.text);
  const source = input.parsed ?? (extracted.found ? extracted.value : undefined);
  if (source === undefined) return { ok: false, reason: "malformed JSON" };

  const normalized = normalizeCritiqueVerdict(source);
  if (!normalized) {
    const record = asObject(source);
    if (!record) return { ok: false, reason: "malformed JSON" };

    const outcome = typeof record.outcome === "string" ? record.outcome.trim() : "";
    if (!outcome) return { ok: false, reason: "missing outcome" };
    if (outcome !== "pass" && outcome !== "fail" && outcome !== "revise") {
      return { ok: false, reason: `invalid outcome: ${outcome}` };
    }
    if (typeof record.critique_md !== "string") return { ok: false, reason: "missing critique_md" };
    return { ok: false, reason: "missing score" };
  }

  return { ok: true, verdict: normalized };
}

function normalizeCritiqueVerdict(value: unknown): CritiqueVerdict | null {
  const record = asObject(value);
  if (!record) return null;

  const legacyScore = extractScoreObject(record.score);
  const strictScore = extractScoreEntries(record.score_entries);
  const score = legacyScore ?? strictScore;
  if (!score) return null;

  const outcome = typeof record.outcome === "string" ? record.outcome.trim() : "";
  if (outcome !== "pass" && outcome !== "fail" && outcome !== "revise") return null;

  const critique_md = typeof record.critique_md === "string" ? record.critique_md : null;
  if (critique_md === null) return null;

  const findings_provenance = extractFindingsProvenance(record.findings_provenance);

  const result: CritiqueVerdict = {
    outcome,
    critique_md,
    score,
  };
  if (findings_provenance !== undefined) {
    result.findings_provenance = findings_provenance;
  }
  return result;
}

/**
 * Extract and validate a findings_provenance array from an unknown value.
 * Drops malformed entries (missing/blank required key, quoted_text shorter than
 * 8 chars, non-integer or <1 line) rather than rejecting the whole verdict.
 * Returns undefined when the field is absent or when every entry is malformed.
 * Preserves original order of surviving entries.
 */
function extractFindingsProvenance(value: unknown): FindingProvenance[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: FindingProvenance[] = [];
  for (const entry of value) {
    const rec = asObject(entry);
    if (!rec) continue;
    const id = typeof rec.id === "string" ? rec.id : null;
    if (!id) continue;
    const file = typeof rec.file === "string" ? rec.file : null;
    if (!file) continue;
    const line = typeof rec.line === "number" && Number.isInteger(rec.line) && rec.line >= 1
      ? rec.line : null;
    if (line === null) continue;
    const quoted_text = typeof rec.quoted_text === "string" ? rec.quoted_text : null;
    if (!quoted_text || quoted_text.length < 8) continue;
    const claim = typeof rec.claim === "string" ? rec.claim : null;
    if (!claim) continue;
    out.push({ id, file, line, quoted_text, claim });
  }
  return out.length > 0 ? out : undefined;
}

function extractScoreObject(value: unknown): Record<string, number> | null {
  const record = asObject(value);
  if (!record) return null;

  const out: Record<string, number> = {};
  for (const [dimension, raw] of Object.entries(record)) {
    const score = asFiniteNumber(raw);
    if (score === null) continue;
    out[dimension] = score;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function extractScoreEntries(value: unknown): Record<string, number> | null {
  if (!Array.isArray(value)) return null;

  const out: Record<string, number> = {};
  for (const entry of value) {
    const record = asObject(entry);
    if (!record) continue;

    const dimension = typeof record.dimension === "string" ? record.dimension.trim() : "";
    const score = asFiniteNumber(record.score);
    if (!dimension || score === null) continue;
    out[dimension] = score;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Return the LAST balanced JSON value in `text`, not the first.
 *
 * WHY THIS EXISTS: with `--output-schema`, the codex CLI emits one
 * `item.completed` event per assistant turn, and each one is a COMPLETE
 * schema-conforming object. On any call where the model uses a tool (e.g. a
 * judge asked to read files) that means two objects: a planning preamble
 * ("I'll inspect the file...") followed by the real answer.
 * parseCodexJsonl concatenates event text, producing `{...}{...}`, which
 * JSON.parse rejects -- so callers fell through to extractJsonValue and got
 * the FIRST object, i.e. the preamble, recorded as the verdict. The model had
 * produced the right answer; the bridge discarded it.
 *
 * When only one object is present, first and last coincide, so this is safe
 * for the no-tool-use path too.
 */
export function extractLastJsonValue(text: string): ExtractedJson {
  const trimmed = text.trim();
  if (!trimmed) return { found: false };
  const direct = tryParseCandidate(trimmed);
  if (direct.found) return direct;

  let best: ExtractedJson = { found: false };
  for (let start = 0; start < trimmed.length; start++) {
    const ch = trimmed[start];
    if (ch !== "{" && ch !== "[") continue;
    const stack: string[] = [ch];
    let inString = false;
    let escaped = false;
    for (let end = start + 1; end < trimmed.length; end++) {
      const current = trimmed[end];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (current === "\\") { escaped = true; continue; }
        if (current === "\"") inString = false;
        continue;
      }
      if (current === "\"") { inString = true; continue; }
      if (current === "{" || current === "[") { stack.push(current); continue; }
      if (current !== "}" && current !== "]") continue;
      const open = stack[stack.length - 1];
      if ((open === "{" && current !== "}") || (open === "[" && current !== "]")) break;
      stack.pop();
      if (stack.length !== 0) continue;
      const parsed = tryParseCandidate(trimmed.slice(start, end + 1).trim());
      if (parsed.found) { best = parsed; start = end; }
      break;
    }
  }
  return best;
}
export function extractJsonValue(text: string): ExtractedJson {
  const trimmed = text.trim();
  if (!trimmed) return { found: false };

  const direct = tryParseCandidate(trimmed);
  if (direct.found) return direct;

  for (const block of extractFencedBlocks(trimmed)) {
    const parsed = tryParseCandidate(block);
    if (parsed.found) return parsed;
  }

  return extractFirstBalancedJson(trimmed);
}

function tryParseCandidate(text: string): ExtractedJson {
  try {
    return { found: true, value: JSON.parse(text) };
  } catch {
    return { found: false };
  }
}

function extractFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const pattern = /```(?:[a-z0-9_-]+)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const body = match[1]?.trim();
    if (body) blocks.push(body);
  }
  return blocks;
}

function extractFirstBalancedJson(text: string): ExtractedJson {
  for (let start = 0; start < text.length; start++) {
    const ch = text[start];
    if (ch !== "{" && ch !== "[") continue;

    const stack: string[] = [ch];
    let inString = false;
    let escaped = false;

    for (let end = start + 1; end < text.length; end++) {
      const current = text[end];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (current === "\\") {
          escaped = true;
          continue;
        }
        if (current === "\"") inString = false;
        continue;
      }

      if (current === "\"") {
        inString = true;
        continue;
      }

      if (current === "{" || current === "[") {
        stack.push(current);
        continue;
      }

      if (current !== "}" && current !== "]") continue;
      const open = stack[stack.length - 1];
      if ((open === "{" && current !== "}") || (open === "[" && current !== "]")) break;
      stack.pop();
      if (stack.length !== 0) continue;

      const parsed = tryParseCandidate(text.slice(start, end + 1).trim());
      if (parsed.found) return parsed;
      break;
    }
  }

  return { found: false };
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
