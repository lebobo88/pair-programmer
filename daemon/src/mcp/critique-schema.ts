type JsonObject = Record<string, unknown>;

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
    },
    required: ["outcome", "critique_md", "score_entries"],
    additionalProperties: false,
  };
}

export function normalizeCritiqueResult<T extends { text: string; parsed?: unknown }>(result: T): T {
  const extracted = extractJsonValue(result.text);
  const source = result.parsed ?? (extracted.found ? extracted.value : undefined);
  const normalized = normalizeCritiqueVerdict(source);
  if (!normalized) return result;
  return {
    ...result,
    text: JSON.stringify(normalized, null, 2),
    parsed: normalized,
  };
}

function normalizeCritiqueVerdict(value: unknown): JsonObject | null {
  const record = asObject(value);
  if (!record) return null;

  const legacyScore = extractScoreObject(record.score);
  const strictScore = extractScoreEntries(record.score_entries);
  const score = legacyScore ?? strictScore;
  if (!score) return null;

  const normalized: JsonObject = { ...record, score };
  delete normalized.score_entries;
  return normalized;
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
