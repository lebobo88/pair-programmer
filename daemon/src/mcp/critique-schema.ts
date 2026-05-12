type JsonObject = Record<string, unknown>;

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
  const source = result.parsed ?? tryParseJson(result.text);
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

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
