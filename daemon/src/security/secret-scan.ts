/**
 * Pattern-based scan for common secret formats. Called before any artifact
 * is written under <project>/.harness/. Conservative: false positives
 * surface as warnings; true positives block the write.
 */

export type SecretMatch = {
  kind: string;
  index: number;
  preview: string;
};

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "openai-api-key",       re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { kind: "openai-project-key",   re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "anthropic-api-key",    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "google-ai-key",        re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { kind: "github-token",         re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { kind: "aws-access-key",       re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "slack-bot-token",      re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "private-key-pem",      re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/g },
  { kind: "dotenv-line",          re: /^[A-Z_][A-Z0-9_]*\s*=\s*['"]?[A-Za-z0-9_+\/=-]{24,}['"]?$/gm },
];

export function scanForSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      matches.push({
        kind,
        index: m.index,
        preview: redact(m[0]),
      });
      if (m.index === re.lastIndex) re.lastIndex++;  // zero-length safety
    }
  }
  return matches;
}

function redact(s: string): string {
  if (s.length <= 8) return "*".repeat(s.length);
  return s.slice(0, 4) + "*".repeat(Math.max(4, s.length - 8)) + s.slice(-4);
}

export class SecretsFoundError extends Error {
  constructor(public readonly matches: SecretMatch[]) {
    super(
      `Secrets found in artifact (${matches.length}): ` +
        matches.map(m => `${m.kind}@${m.index}=${m.preview}`).join(", ")
    );
    this.name = "SecretsFoundError";
  }
}
