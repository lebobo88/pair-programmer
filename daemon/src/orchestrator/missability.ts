/**
 * The 20-item Section-6 "what teams most often miss" check library. Each
 * check is a heuristic inspector that scans the run's artifacts (text
 * content) for evidence the topic was addressed. Returns pass | fail | n/a.
 *
 * Phase 4 ships heuristic regex/structural checks. Phase 9+ may upgrade
 * specific checks to Claude-driven inspection where heuristics underperform.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/database.js";
import { constitutionSha } from "./constitution.js";

export type CheckId =
  | "nfrs-declared"
  | "authz-model"
  | "ui-error-empty-loading"
  | "workflow-exceptions"
  | "retention-deletion"
  | "schema-evolution"
  | "analytics-semantics"
  | "operational-ownership"
  | "feature-flag-lifecycle"
  | "rollout-reversibility"
  | "test-data-management"
  | "third-party-failure"
  | "doc-ownership"
  | "supportability"
  | "accessibility-localization"
  | "security-review-timing"
  | "supply-chain-integrity"
  | "deprecation-sunset"
  | "decision-logging"
  | "ai-evals-hitl"
  | "agents-md-present"
  | "browser-validation-evidence"
  // Game-dev — console / TRC / XR / Lotcheck (gated behind console-cert: true)
  | "controller-disconnect-handling"
  | "save-data-atomicity"
  | "save-format-versioning"
  | "suspend-resume-handling"
  | "language-switch-ux"
  | "achievement-server-authority"
  | "profile-switch-stability"
  | "region-content-gating"
  | "boot-time-budget"
  | "mature-content-age-gate"
  // Game-dev — online / netcode (gated behind online: true)
  | "client-trusted-input"
  | "determinism-claimed-not-enforced"
  | "latency-jitter-visualization"
  | "host-migration-recovery"
  // Game-dev — live-service / monetization / legal (gated behind live-service: true)
  | "lootbox-jurisdiction-declared"
  | "lootbox-drop-rates-published"
  | "coppa-real-money-under-13"
  | "coppa-persistent-id-under-13"
  | "gdpr-k-eu-under-16"
  // Game-dev — accessibility (always-on under game-dev profile)
  | "subtitles-cinematics"
  | "control-remap-core"
  | "color-only-information"
  | "flashing-strobe-control"
  | "timing-accessibility"
  | "text-size-tv-distance"
  | "accessibility-gag-basic"
  // Game-dev — IP / asset / AI provenance (always-on; voice/AI checks are warn-only by convention)
  | "audio-license-record"
  | "font-embedding-license"
  | "ai-voice-consent-record"
  | "steam-ai-disclosure-file"
  | "middleware-licensing-threshold"
  | "ai-provenance-record"
  // Game-dev — perf
  | "perf-budget-evidence"
  // T2 — Constitution attestation (release/retirement runs).
  | "constitution-attestation";

export type MissabilityCtx = {
  project_path: string;
  /** T2: SHA of CONSTITUTION.md recorded at run-start; null when no
   *  constitution file existed at that time. */
  constitution_sha_at_start: string | null;
};

export const CHECK_DEFINITIONS: Array<{
  id: CheckId;
  name: string;
  triggers: (artifactKinds: Set<string>, requiredSections: Set<string>) => boolean;
  evaluate: (texts: ArtifactBundle[], ctx: MissabilityCtx) => { status: "pass" | "fail" | "n/a"; evidence?: string };
}> = [
  {
    id: "nfrs-declared",
    name: "NFRs declared (latency/throughput/availability/recovery/cost)",
    triggers: () => true,
    evaluate: ts => textPatternCheck(ts, /\b(latency|throughput|availability|rto|rpo|p\d{2}|sla|slo|cost ceiling|budget)\b/i),
  },
  {
    id: "authz-model",
    name: "Authorization model written (actor → object → condition)",
    triggers: (k, s) => s.has("4.9") || k.has("threat_model") || k.has("permission_matrix"),
    evaluate: ts => textPatternCheck(ts, /(actor|role|principal).*(can|may|must|cannot).*(read|write|delete|admin|invoke|access)/i),
  },
  {
    id: "ui-error-empty-loading",
    name: "UI 8-state matrix (default/hover/focus/active/loading/empty/error/disabled)",
    triggers: (k, s) => s.has("4.4") || k.has("screen_state_matrix") || k.has("wireframes"),
    evaluate: ts => {
      const text = ts.map(a => a.text).join("\n").toLowerCase();
      const states = ["default", "hover", "focus", "active", "loading", "empty", "error", "disabled"];
      const present = states.filter(s => text.includes(s));
      return present.length >= 6
        ? { status: "pass", evidence: `${present.length}/8 states named` }
        : { status: "fail", evidence: `only ${present.length}/8 states named: ${present.join(",")}` };
    },
  },
  {
    id: "workflow-exceptions",
    name: "Workflow exceptions and manual override paths",
    triggers: (k, s) => s.has("4.2") || s.has("4.3"),
    evaluate: ts => textPatternCheck(ts, /\b(exception|override|escalation|manual approval|fallback flow|out-of-band)\b/i),
  },
  {
    id: "retention-deletion",
    name: "Data retention and deletion rules",
    triggers: (k, s) => s.has("4.5") || s.has("4.9") || k.has("retention_policy"),
    evaluate: ts => textPatternCheck(ts, /\b(retention|retain|delet(e|ion)|tombstone|purge|archive|gdpr|right to be forgotten)\b/i),
  },
  {
    id: "schema-evolution",
    name: "Schema evolution + migration + rollback compatibility",
    triggers: (k, s) => s.has("4.5") || s.has("4.11") || k.has("migration_plan"),
    evaluate: ts => textPatternCheck(ts, /(migration|migrate|backfill|dual.?writ|rollback|backward.?compat|forward.?compat)/i),
  },
  {
    id: "analytics-semantics",
    name: "Analytics event semantics (name + business definition + lineage)",
    triggers: (k, s) => s.has("4.5") || k.has("event_catalog"),
    evaluate: ts => textPatternCheck(ts, /\b(event|metric|kpi)\b.*\b(definition|semantic|lineage|owner)\b/i),
  },
  {
    id: "operational-ownership",
    name: "Operational ownership post-launch (dashboards/alerts/escalation)",
    triggers: (k, s) => s.has("4.12") || s.has("4.11"),
    evaluate: ts => textPatternCheck(ts, /\b(on[- ]?call|owner|escalat|paging|incident|service review)\b/i),
  },
  {
    id: "feature-flag-lifecycle",
    name: "Feature flags have created/observe/retire metadata",
    triggers: (k, s) => s.has("4.11"),
    evaluate: ts => textPatternCheck(ts, /\b(feature[ -]?flag|flag).*(created|owner|retire|expire|sunset)/i),
  },
  {
    id: "rollout-reversibility",
    name: "Rollout strategy + kill switch + comms",
    triggers: (k, s) => s.has("4.11") || k.has("rollout_plan"),
    evaluate: ts => textPatternCheck(ts, /(canary|stag(ed|ing)|rollout|kill[- ]?switch|rollback|blue[- ]?green)/i),
  },
  {
    id: "test-data-management",
    name: "Test data management (provisioning + masking + refresh)",
    triggers: (k, s) => s.has("4.10") || k.has("test_plan"),
    evaluate: ts => textPatternCheck(ts, /\b(test data|fixture|seed data|mask|anonymiz|synthetic data)\b/i),
  },
  {
    id: "third-party-failure",
    name: "Third-party failure modes (outage / quota / rate-limit / contract change / bad data)",
    triggers: (k, s) => s.has("4.7") || s.has("4.9") || k.has("openapi"),
    evaluate: ts => textPatternCheck(ts, /\b(quota|rate[- ]?limit|outage|circuit[- ]?break|backoff|retry|degrad)\w*/i),
  },
  {
    id: "doc-ownership",
    name: "Documentation ownership assigned",
    triggers: () => true,
    evaluate: ts => textPatternCheck(ts, /\b(doc(s|umentation) owner|maintainer|stewardship|@\w+)\b/i),
  },
  {
    id: "supportability",
    name: "Supportability (correlation IDs + admin tools + diagnostic states)",
    triggers: (k, s) => s.has("4.12"),
    evaluate: ts => textPatternCheck(ts, /\b(correlation[- ]?id|trace[- ]?id|admin tool|diagnostic|support sop)\b/i),
  },
  {
    id: "accessibility-localization",
    name: "Accessibility (a11y / WCAG) + localization for UI changes",
    triggers: (k, s) => s.has("4.4") || k.has("screen_state_matrix"),
    evaluate: ts => textPatternCheck(ts, /\b(a11y|aria|wcag|keyboard|screen[- ]?reader|contrast|locale|i18n|rtl)\b/i),
  },
  {
    id: "security-review-timing",
    name: "Threat model produced before code (not after)",
    triggers: (k, s) => s.has("4.9"),
    evaluate: ts => textPatternCheck(ts, /\b(threat[- ]?model|attack tree|stride|asvs|control matrix)\b/i),
  },
  {
    id: "supply-chain-integrity",
    name: "SBOM + provenance retained (enterprise+)",
    triggers: (k, s) => s.has("4.9") || k.has("sbom"),
    evaluate: ts => textPatternCheck(ts, /\b(sbom|cyclonedx|spdx|slsa|provenance|signed.?artifact)\b/i),
  },
  {
    id: "deprecation-sunset",
    name: "Exit path declared at launch",
    triggers: (k, s) => s.has("4.16") || k.has("eol_plan"),
    evaluate: ts => textPatternCheck(ts, /\b(deprecat|retire|sunset|eol|end[- ]?of[- ]?life|migration[- ]?guide)\b/i),
  },
  {
    id: "decision-logging",
    name: "ADR/decision-log entry for non-trivial choices",
    triggers: () => true,
    evaluate: ts => textPatternCheck(ts, /\b(adr|decision[- ]?(log|record)|tradeoff|alternative considered|rationale)\b/i),
  },
  {
    id: "ai-evals-hitl",
    name: "AI eval suite + HITL escalation rule",
    triggers: (k, s) => s.has("4.15") || k.has("ai_system_spec"),
    evaluate: ts => textPatternCheck(ts, /\b(eval(uation)?|benchmark|hitl|human[- ]?in[- ]?the[- ]?loop|guardrail|hallucinat)\w*/i),
  },
  {
    // MC-21 (Phase 12): every run-managed project must have an AGENTS.md (the
    // cross-tool behavioral contract Claude / Codex / Gemini read at session
    // start). CLAUDE.md is its Claude-specific import shim. Both are
    // scaffolded by step 5c of /pp:run via ensure_agents_md, so a missing
    // file at finalize means the lifecycle was bypassed somehow. Triggered
    // on every run.
    id: "agents-md-present",
    name: "AGENTS.md (cross-tool behavioral contract) present at project root",
    triggers: () => true,
    evaluate: (_texts, ctx) => {
      const agentsPath = join(ctx.project_path, "AGENTS.md");
      const claudePath = join(ctx.project_path, "CLAUDE.md");
      const agentsExists = existsSync(agentsPath);
      const claudeExists = existsSync(claudePath);
      if (!agentsExists) {
        return { status: "fail", evidence: `AGENTS.md missing at ${agentsPath}` };
      }
      if (!claudeExists) {
        return { status: "fail", evidence: `CLAUDE.md missing at ${claudePath} (should be a one-line @AGENTS.md import)` };
      }
      // Sanity-check the import shim is wired.
      try {
        const claudeText = readFileSync(claudePath, "utf8");
        if (!/^@AGENTS\.md\b/m.test(claudeText)) {
          return { status: "fail", evidence: `${claudePath}: missing @AGENTS.md import on its own line` };
        }
      } catch {
        return { status: "fail", evidence: `${claudePath}: read error` };
      }
      return { status: "pass", evidence: agentsPath };
    },
  },
  {
    id: "browser-validation-evidence",
    name: "Browser validation evidence (severity clean | warnings)",
    // Triggered when the run's taxonomy includes the QE section (4.10) — the
    // web-ui / mobile profiles also wire this into missability_required so
    // it runs even when 4.10 isn't explicitly mapped.
    triggers: (k, s) => s.has("4.10") || k.has("browser_validation_report"),
    evaluate: ts => {
      const reports = ts.filter(a =>
        a.kind === "browser_validation_report"
        || /\/browser-validation\/report\.md$/.test(a.path)
      );
      if (reports.length === 0) {
        return { status: "fail", evidence: "no browser_validation_report artifact in run" };
      }
      const blocking = reports.find(r => /^severity:\s*errors\b/im.test(r.text));
      if (blocking) {
        return { status: "fail", evidence: `${blocking.path}: severity=errors` };
      }
      // PP-BV-ISO: a browser that could not run records severity="unavailable".
      // It is a degrade-open outcome (the code committed), but it is NOT validation
      // evidence — surface it as a gap so the run is downgraded to "surfaced" and
      // the operator knows this UI flow was never exercised in a browser.
      const unavailable = reports.find(r => /^severity:\s*unavailable\b/im.test(r.text));
      if (unavailable) {
        return {
          status: "fail",
          evidence: `${unavailable.path}: severity=unavailable — browser self-check could not run (code committed; spot-check this UI flow)`,
        };
      }
      const ok = reports.find(r => /^severity:\s*(clean|warnings)\b/im.test(r.text));
      return ok
        ? { status: "pass", evidence: ok.path }
        : { status: "fail", evidence: `${reports[0]!.path}: severity not parseable` };
    },
  },

  // ─── Game-dev: console / TRC / XR / Lotcheck ─────────────────────────
  {
    id: "controller-disconnect-handling",
    name: "Controller disconnect handling on input-bound screens",
    triggers: (k) => k.has("gdd") || k.has("tech_design_doc") || k.has("cert_submission_packet"),
    evaluate: ts => textPatternCheck(ts, /\b(controller[ -]?disconnect|input[ -]?lost|reconnect controller|gamepad disconnect|xr-?\d+\b.*disconnect)/i),
  },
  {
    id: "save-data-atomicity",
    name: "Save-data writes are atomic (temp-file + rename pattern)",
    triggers: (k) => k.has("gdd") || k.has("tech_design_doc") || k.has("code"),
    evaluate: ts => {
      // Two-phase check:
      // 1. If a doc / spec mentions atomic-save explicitly, that's pass.
      const docPass = textPatternCheck(ts, /\b(atomic save|temp[ -]?file.*rename|write[ -]?then[ -]?rename|save[ -]?data integrity|durable write|fsync.*rename)/i);
      if (docPass.status === "pass") return docPass;
      // 2. Scan code artifacts for direct save-write patterns paired with NO atomic evidence in the same artifact.
      const codeArtifacts = ts.filter(a =>
        /\.(cs|cpp|h|hpp|gd|rs|ts|js|py|gml)$/i.test(a.path)
        || a.kind === "code"
      );
      const unsafePatterns = /\b(File\.WriteAllBytes|File\.WriteAllText|fwrite|fs\.writeFile(?!Sync)|fs\.writeFileSync|writeFileSync|saveFile|save_to_file|ResourceSaver\.save|System\.IO\.File\.Write)/;
      const safeNeighborhood = /\b(\.tmp\b|\.partial\b|temp[_-]?file|atomic[_-]?write|rename|fs\.rename|File\.Move|fsync|safeguard[_-]?save)/i;
      for (const a of codeArtifacts) {
        const text = a.text;
        // Look for save-relevant context: "save" in path or text within 200 chars of a write call.
        const saveContext = /save|persistent|profile/i.test(a.path) || /save(?:File|Data|Game|Slot|State)|persist/i.test(text);
        if (!saveContext) continue;
        for (const m of text.matchAll(new RegExp(unsafePatterns.source, "g"))) {
          const idx = m.index ?? 0;
          const window = text.slice(Math.max(0, idx - 200), Math.min(text.length, idx + 400));
          if (!safeNeighborhood.test(window)) {
            return {
              status: "fail",
              evidence: `${a.path}: direct ${m[0]} on save path without atomic-write context`,
            };
          }
        }
      }
      return { status: "fail", evidence: "no atomic-save evidence in any artifact" };
    },
  },
  {
    id: "save-format-versioning",
    name: "Save format has version field + migration path",
    triggers: (k) => k.has("gdd") || k.has("tech_design_doc"),
    evaluate: ts => textPatternCheck(ts, /\b(save[ -]?(format|file).*version|save[ -]?migration|legacy save|backward[ -]?compat.*save|migrateSave)/i),
  },
  {
    id: "suspend-resume-handling",
    name: "Suspend / resume / Quick Resume handled cleanly",
    triggers: (k) => k.has("cert_submission_packet") || k.has("tech_design_doc"),
    evaluate: ts => textPatternCheck(ts, /\b(suspend.*resume|quick[ -]?resume|app[ -]?suspended|background.*foreground|onAppPause|sleep.*wake)/i),
  },
  {
    id: "language-switch-ux",
    name: "UI updates on runtime locale change without restart",
    triggers: (k) => k.has("localization_plan") || k.has("cert_submission_packet"),
    evaluate: ts => textPatternCheck(ts, /\b(runtime locale|language[ -]?switch.*runtime|hot[ -]?reload locale|i18n.*runtime|switch language without restart)/i),
  },
  {
    id: "achievement-server-authority",
    name: "Achievements / trophies trigger server-authoritatively (online titles)",
    triggers: (k) => k.has("cert_submission_packet") || k.has("tech_design_doc"),
    evaluate: ts => textPatternCheck(ts, /\b(server[ -]?authoritative.*(achievement|trophy)|achievement.*server[ -]?(side|auth)|trophy.*server[ -]?(auth|side))/i),
  },
  {
    id: "profile-switch-stability",
    name: "Profile-switch / sign-out mid-session is safe",
    triggers: (k) => k.has("cert_submission_packet") || k.has("tech_design_doc"),
    evaluate: ts => textPatternCheck(ts, /\b(profile[ -]?switch|sign[ -]?out mid[ -]?session|user[ -]?change.*runtime|account[ -]?switch.*safe)/i),
  },
  {
    id: "region-content-gating",
    name: "Region-locked content gated by user region",
    triggers: (k) => k.has("cert_submission_packet"),
    evaluate: ts => textPatternCheck(ts, /\b(region[ -]?lock|region[ -]?gating|user[ -]?region|geo[ -]?gate|region[ -]?restricted)/i),
  },
  {
    id: "boot-time-budget",
    name: "Boot time within platform-tier ceiling",
    triggers: (k) => k.has("performance_profile") || k.has("cert_submission_packet"),
    evaluate: ts => textPatternCheck(ts, /\b(boot[ -]?time|cold[ -]?start|time[ -]?to[ -]?interactive|TTI|launch[ -]?time)\b.*\d/i),
  },
  {
    id: "mature-content-age-gate",
    name: "Mature-rated build presents age-gate flow",
    triggers: (k) => k.has("cert_submission_packet") || k.has("iarc_rating_questionnaire"),
    evaluate: ts => textPatternCheck(ts, /\b(age[ -]?gate|age[ -]?verification|mature.*flow|18\+ verification|esrb m|pegi 18|usk 16|usk 18)\b/i),
  },

  // ─── Game-dev: online / netcode ────────────────────────────────────
  {
    id: "client-trusted-input",
    name: "No client-trusted gameplay input without server reconciliation",
    triggers: (k) => k.has("netcode_topology_design") || k.has("tech_design_doc"),
    evaluate: ts => textPatternCheck(ts, /\b(server[ -]?reconcil|server[ -]?auth|server[ -]?validate|anti[ -]?cheat.*input|server[ -]?side damage|authoritative server)/i),
  },
  {
    id: "determinism-claimed-not-enforced",
    name: "Determinism claimed is actually enforced (seeded RNG, fixed timestep)",
    triggers: (k) => k.has("netcode_topology_design"),
    evaluate: ts => {
      const allText = ts.map(a => a.text).join("\n");
      const claimsRollback = /\b(rollback|deterministic.*lockstep|GGPO)\b/i.test(allText);
      if (!claimsRollback) return { status: "n/a" };
      const hasSeededRng = /\b(seeded[ -]?rng|seeded[ -]?random|deterministic[ -]?rng|fixed[ -]?seed|seed.*frame)/i.test(allText);
      const hasFixedStep = /\b(fixed[ -]?timestep|fixed[ -]?dt|deterministic[ -]?simulation|sim[ -]?tick.*fixed)/i.test(allText);
      return hasSeededRng && hasFixedStep
        ? { status: "pass", evidence: "rollback-claim has seeded-RNG + fixed-timestep" }
        : { status: "fail", evidence: `rollback claimed but ${hasSeededRng ? "" : "no seeded RNG; "}${hasFixedStep ? "" : "no fixed timestep"}`.trim() };
    },
  },
  {
    id: "latency-jitter-visualization",
    name: "Matchmaking surfaces latency / jitter to user",
    triggers: (k) => k.has("netcode_topology_design"),
    evaluate: ts => textPatternCheck(ts, /\b(ping[ -]?indicator|latency[ -]?ui|jitter[ -]?indicator|connection[ -]?quality|netgraph)/i),
  },
  {
    id: "host-migration-recovery",
    name: "Graceful host-migration / disconnect recovery",
    triggers: (k) => k.has("netcode_topology_design"),
    evaluate: ts => textPatternCheck(ts, /\b(host[ -]?migration|reconnect.*session|graceful[ -]?disconnect|session[ -]?resume|server[ -]?failover)/i),
  },

  // ─── Game-dev: live-service / monetization / legal ─────────────────
  {
    id: "lootbox-jurisdiction-declared",
    name: "Loot-box / gacha has per-region gating (BE/NL/EU/CN/US)",
    triggers: (k) => k.has("economy_spreadsheet") || k.has("loot_table"),
    evaluate: ts => {
      const text = ts.map(a => a.text).join("\n").toLowerCase();
      const regions = ["belgium", "netherlands", "china", "eu", "us"];
      const present = regions.filter(r => text.includes(r));
      return present.length >= 4
        ? { status: "pass", evidence: `regions named: ${present.join(",")}` }
        : { status: "fail", evidence: `only ${present.length}/5 regions named: ${present.join(",")}` };
    },
  },
  {
    id: "lootbox-drop-rates-published",
    name: "Loot-box / gacha drop rates published (China + Apple iOS req)",
    triggers: (k) => k.has("economy_spreadsheet") || k.has("loot_table"),
    evaluate: ts => textPatternCheck(ts, /\b(drop[ -]?rate|drop[ -]?probabilit|odds|chance[ -]?disclos|published[ -]?rates|disclosed[ -]?odds)\b/i),
  },
  {
    id: "coppa-real-money-under-13",
    name: "Real-money path for under-13 user requires parental consent (COPPA 2.0)",
    triggers: (k) => k.has("economy_spreadsheet") || k.has("dpia"),
    evaluate: ts => textPatternCheck(ts, /\b(parental[ -]?consent.*purchase|under[ -]?13.*consent|coppa.*purchase|verified[ -]?parental[ -]?consent.*payment)/i),
  },
  {
    id: "coppa-persistent-id-under-13",
    name: "Device-ID / IP collection from under-13 needs compliant consent",
    triggers: (k) => k.has("dpia") || k.has("data_egress_review"),
    evaluate: ts => textPatternCheck(ts, /\b(persistent[ -]?identifier.*consent|device[ -]?id.*under[ -]?13|coppa.*persistent[ -]?id|ip address.*under[ -]?13.*consent)/i),
  },
  {
    id: "gdpr-k-eu-under-16",
    name: "EU under-16 user data requires parental consent (GDPR-K)",
    triggers: (k) => k.has("dpia") || k.has("data_egress_review"),
    evaluate: ts => textPatternCheck(ts, /\b(gdpr[ -]?k|under[ -]?16.*parental|eu.*parental[ -]?consent|article 8 gdpr)/i),
  },

  // ─── Game-dev: accessibility ───────────────────────────────────────
  {
    id: "subtitles-cinematics",
    name: "Subtitles / captions for important speech and cinematics",
    triggers: (k) => k.has("accessibility_plan") || k.has("art_bible") || k.has("dialogue_tree_spec"),
    evaluate: ts => textPatternCheck(ts, /\b(subtitle|caption|closed[ -]?caption|cc[ -]?support)\b/i),
  },
  {
    id: "control-remap-core",
    name: "At least one core mechanic supports control remap",
    triggers: (k) => k.has("accessibility_plan") || k.has("mechanic_spec"),
    evaluate: ts => textPatternCheck(ts, /\b(control[ -]?remap|key[ -]?bind|input[ -]?remap|configurable[ -]?controls|button[ -]?mapping)\b/i),
  },
  {
    id: "color-only-information",
    name: "No information conveyed by color alone (shape/icon redundancy)",
    triggers: (k) => k.has("accessibility_plan") || k.has("art_bible"),
    evaluate: ts => textPatternCheck(ts, /\b(color[ -]?blind|colour[ -]?blind|shape[ -]?redundancy|icon[ -]?redundancy|not color[ -]?alone|deuteranopia|protanopia|tritanopia)/i),
  },
  {
    id: "flashing-strobe-control",
    name: "Flashing / strobe content has skip / disable option",
    triggers: (k) => k.has("accessibility_plan"),
    evaluate: ts => textPatternCheck(ts, /\b(photosensitiv|flashing[ -]?disable|reduce[ -]?flash|strobe[ -]?warning|epilepsy)/i),
  },
  {
    id: "timing-accessibility",
    name: "Critical timing has slowdown / accessibility option",
    triggers: (k) => k.has("accessibility_plan"),
    evaluate: ts => textPatternCheck(ts, /\b(slow[ -]?down|adjust(able)?[ -]?timing|generous[ -]?timing|accessibility[ -]?timing|qte.*skip)/i),
  },
  {
    id: "text-size-tv-distance",
    name: "Body text meets minimum size for console TV-10ft viewing",
    triggers: (k) => k.has("accessibility_plan") || k.has("art_bible"),
    evaluate: ts => textPatternCheck(ts, /\b(font[ -]?size|text[ -]?size|10[ -]?foot|tv[ -]?distance|minimum[ -]?text|legibility)/i),
  },
  {
    id: "accessibility-gag-basic",
    name: "GAG-Basic coverage across all 6 axes (motor/cognitive/vision/hearing/speech/general)",
    triggers: (k, s) => s.has("4.4") || k.has("accessibility_plan"),
    evaluate: ts => {
      const text = ts.map(a => a.text).join("\n").toLowerCase();
      const axes = ["motor", "cognitive", "vision", "hearing", "speech", "general"];
      const present = axes.filter(a => text.includes(a));
      return present.length >= 5
        ? { status: "pass", evidence: `${present.length}/6 axes named` }
        : { status: "fail", evidence: `only ${present.length}/6 GAG axes named: ${present.join(",")}` };
    },
  },

  // ─── Game-dev: IP / asset / AI provenance ─────────────────────────
  {
    id: "audio-license-record",
    name: "Shipped audio has license / origin record",
    triggers: (k) => k.has("sound_design_doc") || k.has("art_bible"),
    evaluate: ts => textPatternCheck(ts, /\b(audio[ -]?license|sfx[ -]?license|music[ -]?license|royalty[ -]?free|attribution|cc[ -]?(by|sa)|sound[ -]?provenance)/i),
  },
  {
    id: "font-embedding-license",
    name: "UI fonts have embedding-redistribution license",
    triggers: (k) => k.has("art_bible") || k.has("accessibility_plan"),
    evaluate: ts => textPatternCheck(ts, /\b(font[ -]?license|font[ -]?embedding|ofl|sil[ -]?ofl|font[ -]?redistribut|google[ -]?fonts|adobe[ -]?fonts)/i),
  },
  {
    id: "ai-voice-consent-record",
    name: "AI-generated voice line has SAG-AFTRA-rider consent record (warn-only)",
    triggers: (k) => k.has("sound_design_doc") || k.has("dialogue_tree_spec"),
    evaluate: ts => textPatternCheck(ts, /\b(sag[ -]?aftra|voice[ -]?consent|ai[ -]?voice[ -]?consent|replica[ -]?consent|voice[ -]?actor[ -]?consent|interactive[ -]?media[ -]?agreement)/i),
  },
  {
    id: "steam-ai-disclosure-file",
    name: "Steam-bound build with player-consumed AI assets has STEAM_AI_DISCLOSURE.md (warn-only)",
    triggers: (k) => k.has("build_release_plan") || k.has("ai_system_spec"),
    evaluate: ts => textPatternCheck(ts, /\b(steam[ -]?ai[ -]?disclosure|steam_ai_disclosure|consumed[ -]?by[ -]?player|store[ -]?disclosure)\b/i),
  },
  {
    id: "middleware-licensing-threshold",
    name: "FMOD / Wwise / SpeedTree / Havok above indie threshold has commercial license artifact",
    triggers: (k) => k.has("sound_design_doc") || k.has("tech_design_doc"),
    evaluate: ts => textPatternCheck(ts, /\b(wwise[ -]?(license|indie|commercial)|fmod[ -]?(license|indie|commercial)|speedtree[ -]?license|havok[ -]?license)\b/i),
  },
  {
    id: "ai-provenance-record",
    name: "Gen-AI shipped assets have AI-PROV.md with model + prompt + training-data note",
    // Only fire when the run actually ships gen-AI assets — image/audio/3d/
    // texture/asset-pack kinds. Previously this triggered on every run,
    // which failed any pure-text ADR/PRD/spec run because no provenance
    // file is meaningful for them; pp-harness's own verdict/attempt trail
    // is the authoritative provenance for synthetic text artifacts.
    triggers: (k) => (
      k.has("image") || k.has("audio") || k.has("model_3d") || k.has("texture") ||
      k.has("asset_pack") || k.has("gen_ai_asset") || k.has("sprite") || k.has("video")
    ),
    evaluate: ts => {
      const hasFile = ts.some(a => /AI[ -_]?PROV(ENANCE)?\.md$/i.test(a.path));
      if (hasFile) return { status: "pass", evidence: "AI-PROV.md present" };
      // Accept verdict/attempt-trail evidence as provenance for runs that
      // produced text artifacts via the harness's own best-of-N tournament.
      // The presence of run.summary.md or a verdicts.jsonl in the run
      // archive is the audit trail.
      const hasHarnessTrail = ts.some(a => /(run\.summary\.md|verdicts\.jsonl|attempts\.jsonl)$/i.test(a.path));
      if (hasHarnessTrail) return { status: "pass", evidence: "harness verdict-trail present (run.summary.md / verdicts.jsonl)" };
      // P5: frontmatter mode — a single artifact (e.g. an ADR) can self-attest
      // by carrying an `ai_provenance:` YAML block in its frontmatter with at
      // least `generator` and `judge` keys. This lets one promoted document
      // file count as provenance on its own, alongside the AI-PROV.md and
      // harness-trail modes.
      const fmHit = ts.find(a => hasAiProvenanceFrontmatter(a.text));
      if (fmHit) return { status: "pass", evidence: `ai_provenance frontmatter in ${fmHit.path}` };
      return textPatternCheck(ts, /\b(ai[ -]?provenance|gen[ -]?ai[ -]?asset|ai[ -]?asset[ -]?disclosure|model[ -]?card|training[ -]?data[ -]?note)/i);
    },
  },

  // ─── Game-dev: perf ───────────────────────────────────────────────
  {
    id: "perf-budget-evidence",
    name: "Performance profile has capture evidence (Unity Profiler / Unreal Insights / RenderDoc / PIX / Razor)",
    triggers: (k) => k.has("performance_profile"),
    evaluate: ts => textPatternCheck(ts, /\b(unity[ -]?profiler|unreal[ -]?insights|renderdoc|\bpix\b|razor[ -]?capture|gpuopen|profile[ -]?capture|frame[ -]?capture|\.upi\b|\.uprofile\b|\.rdc\b)/i),
  },

  // ─── T2 — Constitution attestation ────────────────────────────────
  // Triggered when the run's taxonomy includes Section 4.11 (release) or
  // 4.16 (retirement). Local verification (no TheEights round-trip here):
  // we verify a CONSTITUTION.md exists AND the SHA recorded at run-start
  // still matches the current on-disk SHA. Drift means someone (or
  // something) amended the constitution mid-run; the run is downgraded
  // to `surfaced` so the operator can decide whether to replay against
  // the new SHA. eights.constitution.attest happens separately as a
  // fire-and-forget audit step inside finalize_run.
  {
    id: "constitution-attestation",
    name: "Constitution exists and SHA hasn't drifted since run-start (release/retirement)",
    triggers: (_k, s) => s.has("4.11") || s.has("4.16"),
    evaluate: (_ts, ctx) => {
      if (!ctx.constitution_sha_at_start) {
        return {
          status: "fail",
          evidence: "no CONSTITUTION.md existed at run-start; release/retirement requires one. Run `/pp:constitution` to scaffold.",
        };
      }
      const currentSha = constitutionSha(ctx.project_path);
      if (!currentSha) {
        return {
          status: "fail",
          evidence: "CONSTITUTION.md was present at run-start but is missing now (amendment in-flight?)",
        };
      }
      if (currentSha !== ctx.constitution_sha_at_start) {
        return {
          status: "fail",
          evidence: `constitution_sha drift: start=${ctx.constitution_sha_at_start.slice(0, 12)}… now=${currentSha.slice(0, 12)}…. Replay the run against the new SHA after review.`,
        };
      }
      return { status: "pass", evidence: `constitution_sha pinned at ${currentSha.slice(0, 12)}…` };
    },
  },
];

type ArtifactBundle = {
  path: string;
  kind: string | null;
  text: string;
  // R3-tail Fix 1.2: absolute path of the file we actually loaded text from
  // (after the project_path → .harness/<run_id> → evidence_ref cascade).
  // null when no candidate yielded content.
  resolved_from?: string | null;
};

function textPatternCheck(texts: ArtifactBundle[], re: RegExp): { status: "pass" | "fail"; evidence?: string } {
  for (const a of texts) {
    if (re.test(a.text)) return { status: "pass", evidence: a.path };
  }
  return { status: "fail" };
}

/**
 * P5: detects a YAML frontmatter block with an `ai_provenance:` map that
 * carries at least `generator` and `judge` keys. Returns true on a hit.
 *
 * Accepted shape (between the leading `---` fences):
 *   ai_provenance:
 *     generator: claude-opus-4-7
 *     judge: gemini-3.1-pro-preview
 *     borda_rank: 1                # optional
 *
 * Inline mapping is also accepted (`ai_provenance: {generator: ..., judge: ...}`).
 */
export function hasAiProvenanceFrontmatter(text: string): boolean {
  if (!text || !text.startsWith("---")) return false;
  // Pull the frontmatter block: from the first `---` line to the next one.
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return false;
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") { endIdx = i; break; }
  }
  if (endIdx === -1) return false;
  const fm = lines.slice(1, endIdx).join("\n");

  // Inline mapping form: ai_provenance: {generator: ..., judge: ...}
  const inlineMatch = fm.match(/^ai_provenance:\s*\{([^}]*)\}\s*$/m);
  if (inlineMatch) {
    const inner = inlineMatch[1] ?? "";
    return /\bgenerator\s*:/.test(inner) && /\bjudge\s*:/.test(inner);
  }

  // Block-mapping form: ai_provenance: header followed by indented
  // generator/judge keys. Walk the lines to extract the indented block,
  // stopping at the first dedented (column-0 non-empty) line.
  const fmLines = fm.split(/\r?\n/);
  let i = 0;
  for (; i < fmLines.length; i++) {
    if (/^ai_provenance:\s*$/.test(fmLines[i]!)) break;
  }
  if (i < fmLines.length) {
    let hasGen = false;
    let hasJudge = false;
    for (let j = i + 1; j < fmLines.length; j++) {
      const ln = fmLines[j]!;
      if (ln.length > 0 && !/^\s/.test(ln)) break; // dedent — end of block
      if (/^\s+generator\s*:/.test(ln)) hasGen = true;
      if (/^\s+judge\s*:/.test(ln)) hasJudge = true;
    }
    return hasGen && hasJudge;
  }
  return false;
}

export function runMissabilityChecks(opts: {
  run_id: string;
  required_check_ids?: CheckId[];
}): {
  results: Array<{ check_id: CheckId; status: "pass" | "fail" | "n/a"; evidence?: string }>;
  pass_count: number;
  fail_count: number;
  na_count: number;
} {
  const run = db().prepare(`SELECT project_path, taxonomy_mapping_json, constitution_sha FROM runs WHERE id = ?`).get(opts.run_id) as
    | { project_path: string; taxonomy_mapping_json: string | null; constitution_sha: string | null }
    | undefined;
  if (!run) throw new Error(`run ${opts.run_id} not found`);

  const artifactRows = db()
    .prepare(`SELECT path, kind, evidence_ref FROM artifacts WHERE run_id = ?`)
    .all(opts.run_id) as Array<{ path: string; kind: string | null; evidence_ref: string | null }>;

  // R3-tail Fix 1.2 (2026-05-21): resolve artifact text through a 3-step
  // cascade so checks don't silently fail when the artifact was archived
  // as a patch under `.harness/<run_id>/` instead of the project tree.
  //
  //   1. If `evidence_ref` is set on the row, load `<project>/<evidence_ref>`
  //      FIRST — the producer explicitly told us where the substantive
  //      intent lives (typically a DR file). evidence_ref wins over the
  //      patch path because the patch is a record of what changed, not
  //      what the intent says.
  //   2. Try `<project>/<path>` — the canonical artifact location.
  //   3. Try `<project>/.harness/<run_id>/<path>` — patches archived
  //      during the run.
  //
  // Each candidate path tried gets its result hashed into `text`. The
  // first non-empty load wins. Empty after all three = check evaluates
  // against empty text, same as the pre-fix behavior.
  const runArchiveRoot = join(run.project_path, ".harness", opts.run_id);
  const texts: ArtifactBundle[] = artifactRows.map(r => {
    let text = "";
    let resolvedFrom: string | null = null;
    const candidates = [
      r.evidence_ref ? join(run.project_path, r.evidence_ref) : null,
      join(run.project_path, r.path),
      join(runArchiveRoot, r.path),
    ].filter((p): p is string => p !== null);
    for (const abs of candidates) {
      try {
        if (existsSync(abs)) {
          text = readFileSync(abs, "utf8");
          if (text.length > 0) { resolvedFrom = abs; break; }
        }
      } catch { /* ignore */ }
    }
    return { path: r.path, kind: r.kind, text, resolved_from: resolvedFrom };
  });

  const artifactKinds = new Set(artifactRows.map(r => r.kind ?? "").filter(Boolean));
  let requiredSections = new Set<string>();
  if (run.taxonomy_mapping_json) {
    try {
      const mapping = JSON.parse(run.taxonomy_mapping_json) as { sections?: Array<{ id: string }> };
      requiredSections = new Set((mapping.sections ?? []).map(s => s.id));
    } catch { /* ignore */ }
  }

  const requiredSet = new Set<CheckId>(opts.required_check_ids ?? []);
  const results: Array<{ check_id: CheckId; status: "pass" | "fail" | "n/a"; evidence?: string }> = [];
  for (const def of CHECK_DEFINITIONS) {
    const required = requiredSet.has(def.id);
    const triggered = def.triggers(artifactKinds, requiredSections);
    if (!required && !triggered) {
      results.push({ check_id: def.id, status: "n/a" });
      continue;
    }
    const r = def.evaluate(texts, {
      project_path: run.project_path,
      constitution_sha_at_start: run.constitution_sha,
    });
    results.push({ check_id: def.id, status: r.status, evidence: r.evidence });
  }

  // Persist to missability_checks table.
  const now = new Date().toISOString();
  const stmt = db().prepare(
    `INSERT INTO missability_checks(id, run_id, check_id, status, evidence_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const r of results) {
    stmt.run(`mc_${Math.random().toString(36).slice(2, 12)}`, opts.run_id, r.check_id, r.status, r.evidence ?? null, now);
  }

  const pass_count = results.filter(r => r.status === "pass").length;
  const fail_count = results.filter(r => r.status === "fail").length;
  const na_count   = results.filter(r => r.status === "n/a").length;
  return { results, pass_count, fail_count, na_count };
}
