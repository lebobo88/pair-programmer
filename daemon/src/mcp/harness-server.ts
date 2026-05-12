import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorContent, jsonContent, zodToJsonSchema } from "./helpers.js";
import {
  startRun, startStage, recordAttempt, recordVerdict, finalizeStage,
  finalizeRun, archiveArtifact, listRuns, getRun, budgetStatus, doctor,
  recordTaxonomyMapping,
} from "../orchestrator/runs.js";
import { evaluateGate, listAllowedJudges, type GateType, type Profile } from "../orchestrator/gates.js";
import { heuristicTriage, heuristicMapping, TAXONOMY_SECTIONS, COMPLETION_CHECKLIST } from "../orchestrator/taxonomy.js";
import { applyMasterPlanPatch, masterPlanStatus, ensureMasterPlan } from "../orchestrator/master-plan.js";
import { runMissabilityChecks, CHECK_DEFINITIONS, type CheckId } from "../orchestrator/missability.js";
import { loopCeilingStatus, checkRetryEligible } from "../orchestrator/loop-ceiling.js";
import { startBestOfStage, diffEntropy, bordaCount, archiveWinnerAndLosers, teardownCandidates, recordSmokeStatus } from "../orchestrator/best-of-n.js";
import { runTddCheck, getLatestTddCheck } from "../orchestrator/tdd-gate.js";
import {
  runArtifactValidator,
  getLatestArtifactValidation,
  VALIDATOR_KINDS,
} from "../orchestrator/artifact-validators/index.js";
import { loadProjectProfile, getBuiltinProfile, listBuiltinProfiles, writeProjectProfile, BUILTIN_PROFILES, BUILTIN_PROFILE_NAMES, type ProfileName } from "../orchestrator/profiles.js";
import { detectProfile } from "../orchestrator/profile-detect.js";
import { visualRegressionCapture, visualRegressionDiff } from "../orchestrator/visual-regression.js";
import { browserValidationStart, browserValidationFinalize } from "../orchestrator/browser-validation.js";
import { getRubric, listRubrics } from "../rubrics/registry.js";
import { getTeam, listTeams } from "../orchestrator/teams.js";
import { getDesignTemplate, TEMPLATES_BY_KIND } from "../orchestrator/design-templates.js";
import { listForums, getForum } from "../orchestrator/forums.js";
import { runJanitor } from "../orchestrator/janitor.js";
import { buildReplayBundle } from "../orchestrator/replay.js";
import {
  RUN_MODE,
  STAGE_STATUS,
  ATTEMPT_STATUS,
  VERDICT_OUTCOME,
  RUN_STATUS,
  CLAUDE_TIER_MODELS,
  COPILOT_CLAUDE_TIER_MODELS,
  TIER_ORDER,
} from "../config.js";
import { log } from "../util/logger.js";

// ─── Input schemas ───────────────────────────────────────────────────────

const StartRunSchema = z.object({
  request_text: z.string().min(1),
  project_path: z.string().min(1),
  mode:         z.enum(RUN_MODE),
  team:         z.string().optional(),
  forum:        z.string().optional(),
  n:            z.number().int().min(1).max(8).optional(),
  session_id:   z.string().optional(),
});

const StartStageSchema = z.object({
  run_id:    z.string().min(1),
  kind:      z.string().min(1),
  gate_type: z.string().min(1),
});

const RecordAttemptSchema = z.object({
  stage_id:           z.string().min(1),
  producer:           z.string().min(1),
  model_id:           z.string().min(1),
  prompt_hash:        z.string().optional(),
  artifact_path:      z.string().optional(),
  tokens_in:          z.number().int().nonnegative().optional(),
  tokens_out:         z.number().int().nonnegative().optional(),
  cost_usd:           z.number().nonnegative().optional(),
  wall_ms:            z.number().int().nonnegative().optional(),
  retry_index:        z.number().int().min(0).max(2).optional(),
  parent_attempt_id:  z.string().optional(),
  status:             z.enum(ATTEMPT_STATUS).optional(),
  // Best-of-N: when start_best_of_stage pre-allocates candidate slots, the
  // generator agent passes the slot id back here so the row id matches the
  // slot. Idempotent on re-call within the same slot.
  attempt_slot_id:    z.string().optional(),
  // Tier the driver resolved for this attempt. Only meaningful when
  // producer === "claude"; the daemon does not enforce — it just records
  // for cost-by-tier analytics and replay determinism.
  attempted_tier:     z.enum(["opus", "sonnet", "haiku"]).optional(),
});

const RecordVerdictSchema = z.object({
  attempt_id:     z.string().min(1),
  judge_producer: z.string().min(1),
  judge_model_id: z.string().min(1),
  rubric_id:      z.string().optional(),
  outcome:        z.enum(VERDICT_OUTCOME),
  critique_md:    z.string().optional(),
  // Accept either an object (well-typed MCP clients) or a JSON-string (any-type
  // clients that fall back to string serialization for untyped params). The
  // string arm parses to an object before the refines below run, so the
  // typeof-object guard never sees a raw string.
  score_json:     z.union([
    z.record(z.string(), z.unknown()),
    z.string().transform((s) => {
      try { return JSON.parse(s); } catch { return {}; }
    }),
  ]).optional(),
})
  // Belt-and-suspenders against the "pragmatic pass" loophole. The judge
  // sub-agents already refuse to call this tool on critique-tool failure
  // (they return judge_tool_failed=true to the parent driver instead) — but
  // if a future regression slips through, the daemon refuses to record a
  // pass with no substantive evidence. A real verdict has a critique > a few
  // lines and ≥1 rubric-dimension score.
  .refine(
    v => v.outcome !== "pass" || (typeof v.critique_md === "string" && v.critique_md.trim().length >= 80),
    { message: "outcome=pass requires critique_md of at least 80 non-whitespace chars (anti-vacuous-pass guard)" }
  )
  .refine(
    v => {
      if (v.outcome !== "pass") return true;
      const s = v.score_json;
      return !!s && typeof s === "object" && !Array.isArray(s) && Object.keys(s as Record<string, unknown>).length > 0;
    },
    { message: "outcome=pass requires non-empty score_json with at least one rubric dimension (anti-vacuous-pass guard)" }
  );

const FinalizeStageSchema = z.object({
  stage_id:          z.string().min(1),
  status:            z.enum(STAGE_STATUS),
  winner_attempt_id: z.string().optional(),
});

const FinalizeRunSchema = z.object({
  run_id:     z.string().min(1),
  status:     z.enum(["complete", "surfaced", "aborted"] as const),
  summary_md: z.string().optional(),
});

const ArchiveArtifactSchema = z.object({
  run_id:           z.string().min(1),
  stage_id:         z.string().optional(),
  taxonomy_section: z.string().optional(),
  kind:             z.string().optional(),
  relative_path:    z.string().min(1),
  bytes:            z.string(),
  // Manual-edit recovery: when archive_artifact detects that the on-disk file
  // hash differs from the stored hash, it returns `manual_edit_detected`
  // instead of clobbering. Pass `force_overwrite: true` to clobber anyway.
  force_overwrite:  z.boolean().optional(),
});

const ListRunsSchema = z.object({
  project_path: z.string().optional(),
  status:       z.enum(RUN_STATUS).optional(),
  limit:        z.number().int().min(1).max(500).optional(),
});

const GetRunSchema = z.object({ run_id: z.string().min(1) });
const BudgetStatusSchema = z.object({ scope: z.string().optional() });

const GATE_TYPES = ["spec", "design", "security", "contract", "code_style", "docs_polish", "lint_class"] as const;

const GateEligibleJudgesSchema = z.object({
  gate_type:           z.enum(GATE_TYPES),
  generator_producer:  z.string().min(1),
  prompt_keywords:     z.string().optional(),
  profile:             z.enum(BUILTIN_PROFILE_NAMES).optional(),
  artifact_kind:       z.string().optional(),
});

const TriageRequestSchema = z.object({
  request_text:  z.string().min(1),
  diff_loc:      z.number().int().nonnegative().optional(),
  files_touched: z.number().int().nonnegative().optional(),
});

const TaxonomyMapRequestSchema = TriageRequestSchema.extend({
  scope: z.enum(["trivial", "standard", "major"]).optional(),
});

const RecordTaxonomyMappingSchema = z.object({
  run_id: z.string().min(1),
  scope:  z.enum(["trivial", "standard", "major"]),
  signals: z.array(z.string()),
  sections: z.array(z.object({
    id: z.string(),
    title: z.string(),
    rationale: z.string(),
    required_artifacts: z.array(z.string()),
  })),
  missability_required: z.array(z.string()),
});

const MasterPlanPatchSchema = z.object({
  run_id:       z.string().min(1),
  project_path: z.string().min(1),
  section:      z.string().min(1),
  kind:         z.enum(["create", "update", "append"]),
  content_md:   z.string().min(1),
});

const MasterPlanStatusSchema = z.object({ project_path: z.string().min(1) });
const EnsureMasterPlanSchema  = z.object({ project_path: z.string().min(1) });
const TaxonomyListSchema      = z.object({});

const RunMissabilitySchema = z.object({
  run_id: z.string().min(1),
  required_check_ids: z.array(z.string()).optional(),
});

const LoopCeilingSchema = z.object({ run_id: z.string().min(1) });

const RetryWithCritiqueSchema = z.object({
  attempt_id: z.string().min(1),
  critique_md: z.string().min(1),
  budget_override: z.boolean().optional(),
});

const ListMissabilityChecksSchema = z.object({});

const StartBestOfStageSchema = z.object({
  run_id:    z.string().min(1),
  kind:      z.string().min(1),
  gate_type: z.string().min(1),
  n:         z.number().int().min(2).max(8),
});

const DiffEntropySchema = z.object({
  candidate_texts: z.array(z.string()).min(2),
});

const BordaSchema = z.object({
  candidate_ids: z.array(z.string()).min(2),
  rankings:      z.array(z.array(z.string())).min(1),
});

const RecordSmokeStatusSchema = z.object({
  stage_id:        z.string().min(1),
  candidate_index: z.number().int().min(1).max(8),
  status:          z.enum(["pass", "fail", "infra_error", "skipped"]),
  reason:          z.string().optional(),
});

const TddPreCheckSchema = z.object({
  stage_id: z.string().min(1),
});

const TddPostCheckSchema = z.object({
  stage_id: z.string().min(1),
});

const GetTddCheckSchema = z.object({
  stage_id: z.string().min(1),
  phase:    z.enum(["pre", "post"]),
});

const ArtifactValidateSchema = z.object({
  stage_id:      z.string().min(1),
  kind:          z.enum(VALIDATOR_KINDS),
  artifact_path: z.string().optional(),
});

const GetArtifactValidationSchema = z.object({
  stage_id:       z.string().min(1),
  validator_kind: z.enum(VALIDATOR_KINDS),
  artifact_id:    z.string().optional(),
});

const ArchiveWinnerSchema = z.object({
  run_id:                  z.string().min(1),
  stage_id:                z.string().min(1),
  stage_kind:              z.string().min(1),
  winner_candidate_index:  z.number().int().min(1),
  candidate_paths:         z.array(z.string()).min(1),
});

const TeardownCandidatesSchema = z.object({
  project_path:    z.string().min(1),
  candidate_paths: z.array(z.string()).min(1),
  run_id:          z.string().min(1),
  stage_kind:      z.string().min(1),
  allow_data_loss: z.boolean().optional(),
});

const GetProfileSchema      = z.object({ project_path: z.string().min(1) });
const GetBuiltinProfileSchema = z.object({ name: z.enum(BUILTIN_PROFILE_NAMES) });
const GetRubricSchema       = z.object({ id: z.string().min(1) });
const ListRubricsSchema     = z.object({});
const ListProfilesSchema    = z.object({});
const GetClaudeTierModelsSchema = z.object({});
const DetectProfileSchema   = z.object({ project_path: z.string().min(1) });
const WriteProfileSchema    = z.object({
  project_path: z.string().min(1),
  name:         z.enum(BUILTIN_PROFILE_NAMES),
  source:       z.enum(["detected", "user-selected"]),
  run_id:       z.string().optional(),
  signals:      z.array(z.string()).optional(),
});

const GetTeamSchema  = z.object({ name: z.string().min(1), project_path: z.string().min(1) });
const ListTeamsSchema = z.object({ project_path: z.string().min(1) });

const GetDesignTemplateSchema = z.object({ kind: z.string().min(1) });
const ListDesignTemplatesSchema = z.object({});

const GetForumSchema  = z.object({ id: z.string().min(1) });
const ListForumsSchema = z.object({});

const JanitorSchema = z.object({});
const ReplaySchema  = z.object({ run_id: z.string().min(1) });

const VisualRegressionCaptureSchema = z.object({
  run_id:    z.string().min(1),
  phase:     z.enum(["before", "after"]),
  urls:      z.array(z.string().min(1)).min(1),
  base_url:  z.string().optional(),
  viewport:  z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  full_page: z.boolean().optional(),
});
const VisualRegressionDiffSchema = z.object({ run_id: z.string().min(1) });

const BrowserValidationStartSchema = z.object({
  run_id:   z.string().min(1),
  base_url: z.string().optional(),
  routes:   z.array(z.string().min(1)).min(1),
});
const BrowserValidationFinalizeSchema = z.object({
  run_id:   z.string().min(1),
  stage_id: z.string().min(1),
  engine:   z.enum(["chrome-mcp", "playwright"]),
  base_url: z.string().optional(),
  gif_path: z.string().optional(),
  findings: z.array(z.object({
    route: z.string(),
    step:  z.string(),
    status: z.enum(["pass", "warn", "fail"]),
    console_errors: z.array(z.string()).default([]),
    network_errors: z.array(z.object({ url: z.string(), status: z.number().int() })).default([]),
    screenshot_path: z.string().optional(),
  })),
});

// ─── Tool registry ───────────────────────────────────────────────────────

type ToolDef = {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: (args: unknown) => Promise<unknown> | unknown;
};

const TOOLS: ToolDef[] = [
  {
    name: "start_run",
    description:
      "Allocate a run row in the harness DB and create the per-run artifact directory. Returns run_id and absolute artifact_dir path.",
    schema: StartRunSchema,
    handler: (args) => startRun(StartRunSchema.parse(args)),
  },
  {
    name: "start_stage",
    description:
      "Open a stage row inside an active run. kind is one of spec | design | architecture | contracts | code | security | tests | docs | release | ops | data | ux | design_system | release_plan | retirement | taxonomy_close. gate_type drives the validator policy.",
    schema: StartStageSchema,
    handler: (args) => startStage(StartStageSchema.parse(args)),
  },
  {
    name: "record_attempt",
    description:
      "Log a generation attempt against an open stage. Pass tokens_in/out and cost_usd for budget tallying. retry_index>=1 indicates a Reflexion retry; pass parent_attempt_id to link.",
    schema: RecordAttemptSchema,
    handler: (args) => recordAttempt(RecordAttemptSchema.parse(args)),
  },
  {
    name: "record_verdict",
    description:
      "Log a judge verdict against an attempt. cross_vendor is computed by the daemon based on judge_producer vs attempt's producer. outcome is pass | fail | revise.",
    schema: RecordVerdictSchema,
    handler: (args) => recordVerdict(RecordVerdictSchema.parse(args)),
  },
  {
    name: "finalize_stage",
    description:
      "Close a stage row with status passed | surfaced | skipped. winner_attempt_id is required when status=passed.",
    schema: FinalizeStageSchema,
    handler: (args) => finalizeStage(FinalizeStageSchema.parse(args)),
  },
  {
    name: "finalize_run",
    description:
      "Close a run with status complete | surfaced | aborted. If summary_md is provided, writes it to <project>/.harness/<run_id>/run.summary.md.",
    schema: FinalizeRunSchema,
    handler: (args) => finalizeRun(FinalizeRunSchema.parse(args)),
  },
  {
    name: "archive_artifact",
    description:
      "Write artifact bytes to <project>/.harness/<run_id>/<relative_path> and register it. Bytes are pre-scanned for secrets; matches throw and the artifact is NOT written. Manual-edit detection: if a prior archive of the same path exists and the on-disk file's hash differs from the stored hash, the call returns {status: 'manual_edit_detected', stored_sha, current_sha, message} instead of clobbering. Pass force_overwrite=true to override.",
    schema: ArchiveArtifactSchema,
    handler: (args) => archiveArtifact(ArchiveArtifactSchema.parse(args)),
  },
  {
    name: "list_runs",
    description:
      "List recent runs, optionally filtered by project_path and/or status. Returns up to `limit` rows (default 50).",
    schema: ListRunsSchema,
    handler: (args) => listRuns(ListRunsSchema.parse(args)),
  },
  {
    name: "get_run",
    description:
      "Return the full tree for a run: run row, all stages, all attempts, all verdicts, all artifacts.",
    schema: GetRunSchema,
    handler: (args) => getRun(GetRunSchema.parse(args).run_id),
  },
  {
    name: "budget_status",
    description:
      "Return budget rows. Pass a specific scope (run:<id>, day:YYYY-MM-DD, model:<id>) to filter; otherwise returns the 100 most recently-updated scopes.",
    schema: BudgetStatusSchema,
    handler: (args) => budgetStatus(BudgetStatusSchema.parse(args).scope),
  },
  {
    name: "doctor",
    description:
      "Health-check: reports CLI versions, DB reachability, configured vendors, and whether cross_vendor is satisfied. Pass `smoke: true` to also exercise each vendor's critique CLI end-to-end (catches model-not-served / auth / command-line-too-long failures); adds 10–60s per configured vendor. Use this at session start.",
    schema: z.object({ smoke: z.boolean().optional() }),
    handler: async (args) => await doctor({ smoke: !!(args as { smoke?: boolean }).smoke }),
  },
  {
    name: "triage_request",
    description:
      "Heuristic classifier returning {scope: trivial|standard|major, signals: string[]}. Phase 3 ships a regex-based classifier; the driver is free to override based on richer reasoning. trivial → minimum-artifact rule (changelog only); major → forces team mode.",
    schema: TriageRequestSchema,
    handler: (args) => heuristicTriage(TriageRequestSchema.parse(args)),
  },
  {
    name: "map_taxonomy",
    description:
      "Heuristic taxonomy mapper returning {scope, sections: [{id, title, rationale, required_artifacts}], missability_required}. Driver may augment this with a Claude-driven mapping then call record_taxonomy_mapping with the final result.",
    schema: TaxonomyMapRequestSchema,
    handler: (args) => heuristicMapping(TaxonomyMapRequestSchema.parse(args)),
  },
  {
    name: "record_taxonomy_mapping",
    description:
      "Persist the taxonomy mapping for a run. Writes both runs.taxonomy_mapping_json and a per-run taxonomy_mapping.json artifact under .harness/<run_id>/.",
    schema: RecordTaxonomyMappingSchema,
    handler: (args) => recordTaxonomyMapping(RecordTaxonomyMappingSchema.parse(args)),
  },
  {
    name: "list_taxonomy_sections",
    description:
      "Returns the 16 taxonomy_blueprint.md sections (4.1..4.16) with default artifact kinds and the master-plan section each maps to.",
    schema: TaxonomyListSchema,
    handler: () => TAXONOMY_SECTIONS,
  },
  {
    name: "ensure_master_plan",
    description:
      "Creates <project>/PROJECT_MASTER.md from the Section 9 20-section template if absent. Idempotent. Returns {path, created: boolean}.",
    schema: EnsureMasterPlanSchema,
    handler: (args) => ensureMasterPlan(EnsureMasterPlanSchema.parse(args).project_path),
  },
  {
    name: "apply_master_plan_patch",
    description:
      "Patches a section of <project>/PROJECT_MASTER.md and records the prev/new sha to master_plan_patches. kind=create scaffolds the section if missing; update replaces; append concatenates after existing content.",
    schema: MasterPlanPatchSchema,
    handler: (args) => applyMasterPlanPatch(MasterPlanPatchSchema.parse(args)),
  },
  {
    name: "master_plan_status",
    description:
      "Returns the current state of <project>/PROJECT_MASTER.md: which of the 20 sections are populated, total bytes, and Section 10's 15-item completion checklist (each item pass/fail based on its mapped section).",
    schema: MasterPlanStatusSchema,
    handler: (args) => masterPlanStatus(MasterPlanStatusSchema.parse(args).project_path),
  },
  {
    name: "completion_checklist",
    description:
      "Returns Section 10's 15 verbatim completion-checklist items.",
    schema: TaxonomyListSchema,
    handler: () => COMPLETION_CHECKLIST,
  },
  {
    name: "list_missability_checks",
    description:
      "Returns the 20-item Section 6 missability check library: id, human name, and a hint at what triggers each.",
    schema: ListMissabilityChecksSchema,
    handler: () => CHECK_DEFINITIONS.map(c => ({ id: c.id, name: c.name })),
  },
  {
    name: "run_missability_checks",
    description:
      "Runs the 20-item missability library against a run's archived artifacts. required_check_ids forces those checks to run regardless of their trigger predicate (used to honor record_taxonomy_mapping.missability_required). Returns per-check status and a tally.",
    schema: RunMissabilitySchema,
    handler: (args) => {
      const parsed = RunMissabilitySchema.parse(args);
      return runMissabilityChecks({
        run_id: parsed.run_id,
        required_check_ids: parsed.required_check_ids as CheckId[] | undefined,
      });
    },
  },
  {
    name: "loop_ceiling_status",
    description:
      "Returns the validator-call count for a run vs the configured ceiling (default 6). When blocked=true, retry_with_critique will refuse unless budget_override=true is passed.",
    schema: LoopCeilingSchema,
    handler: (args) => loopCeilingStatus(LoopCeilingSchema.parse(args).run_id),
  },
  {
    name: "start_best_of_stage",
    description:
      "Open a stage and pre-allocate N candidate slots, each with its own git worktree (or copy-fallback) under .harness/<run_id>/<kind>/candidate-{1..N}/. Returns {stage_id, candidates: [{candidate_index, attempt_slot_id, worktree_path, worktree_mode}], shuffle_seed}. Refuses to open the stage unless at least one non-Claude vendor (openai or google) is reachable, since best-of-N candidates run as Claude and judging needs cross-vendor capability. Override with PP_ALLOW_BEST_OF_WITHOUT_JUDGE=1 (same-vendor Claude judging only). The driver fans out N parallel Claude Task sub-agents, one per candidate.",
    schema: StartBestOfStageSchema,
    handler: async (args) => {
      return await startBestOfStage(StartBestOfStageSchema.parse(args));
    },
  },
  {
    name: "diff_entropy",
    description:
      "Compute pairwise Jaccard similarity over candidate artifact texts. Returns {max_similarity, pairwise, warning}. If max_similarity > 0.9, the warning surfaces a 'low-diversity' note for the driver to show the user.",
    schema: DiffEntropySchema,
    handler: (args) => diffEntropy(DiffEntropySchema.parse(args)),
  },
  {
    name: "borda_count",
    description:
      "Borda-count tournament over candidate ids using one or more rankings (best-first ordered lists). Returns {winner, scores}. Used when N>=3 and you have multiple judge rankings (e.g., the cross-vendor judge plus the user's preference).",
    schema: BordaSchema,
    handler: (args) => bordaCount(BordaSchema.parse(args)),
  },
  {
    name: "record_smoke_status",
    description:
      "Persist the runtime smoke-test outcome for a best-of-N candidate. status is pass | fail | infra_error | skipped. Stored in stages.notes_json.smoke_results[<candidate_index>]. archive_winner_and_losers refuses to merge any candidate with status='fail' (returns merge_status='smoke_failed') unless PP_ALLOW_SMOKE_FAILED_WINNER=1 is set. Engineers call this from their Verification step in engineer.md after booting the dev server, hitting routes, and scanning logs for crash patterns.",
    schema: RecordSmokeStatusSchema,
    handler: (args) => recordSmokeStatus(RecordSmokeStatusSchema.parse(args)),
  },
  {
    name: "tdd_pre_check",
    description:
      "TDD execution gate, pre-code phase. Required for any tests_pre stage in refactor-team / bug-fix-team / feature-team-tdd. Reads the kind='tdd_manifest' artifact archived at the tests_pre stage, validates the test_command against the runner allowlist (npx, node, python, pytest, go, cargo, ...; refuses shell metacharacters), executes it in project_path with a timeout (default 5min, max 15min), parses framework-specific output (vitest/jest/mocha/pytest/go-test/cargo-test/unittest/playwright), and compares actual outcome to manifest.expected_pre_outcome. Persists a tdd_checks row with status='verified' | 'violation' | 'execution_error'. The output_path field points to the captured stdout+stderr log. finalize_stage refuses to mark a tests_pre stage 'passed' without a verified row — call this between the tests_pre judge-pass and finalize_stage. On 'violation' the driver should trigger reflexion-coach; on 'execution_error' the driver should surface and investigate (network, missing deps, broken runner config).",
    schema: TddPreCheckSchema,
    handler: async (args) => await runTddCheck({ stage_id: TddPreCheckSchema.parse(args).stage_id, phase: "pre" }),
  },
  {
    name: "tdd_post_check",
    description:
      "TDD execution gate, post-code phase. Pass the CODE stage_id (not the tests_pre id); the daemon resolves the immediately-prior tests_pre stage in the same run, reads its tdd_manifest, and re-executes manifest.test_command against the now-coded tree. Compares actual to manifest.expected_post_outcome (always 'all_pass' for all three modes — the failing test now passes, characterization tests still pass, acceptance tests now pass). Persists a tdd_checks row keyed by (code_stage_id, phase='post'). finalize_stage refuses to mark a code stage 'passed' when its predecessor was tests_pre and no verified post row exists. Same allowlist + timeout + parser as tdd_pre_check.",
    schema: TddPostCheckSchema,
    handler: async (args) => await runTddCheck({ stage_id: TddPostCheckSchema.parse(args).stage_id, phase: "post" }),
  },
  {
    name: "get_tdd_check",
    description:
      "Returns the latest tdd_checks row for (stage_id, phase) or null. Use after tdd_pre_check / tdd_post_check returns to inspect status, actual vs expected, runner output path, and reason. The driver consults this to decide whether to advance, surface, or trigger reflexion.",
    schema: GetTddCheckSchema,
    handler: (args) => {
      const p = GetTddCheckSchema.parse(args);
      return { check: getLatestTddCheck(p.stage_id, p.phase) };
    },
  },
  {
    name: "artifact_validate",
    description:
      "Artifact validator gate. Runs a structural validator (currently: adr_structure_lint; contracts_lint, tokens_build, mermaid_render, c4_render are reserved kinds for follow-up landings) over an archived artifact. The driver calls this after the judge passes the artifact's stage and before finalize_stage. Resolution: when artifact_path is omitted, the daemon picks the most recent archived artifact whose kind binds to the validator (e.g. adr_structure_lint→artifact.kind='adr'). Status outcomes: 'verified' (gate passes), 'violation' (artifact malformed — e.g. ADR missing 'Decision' section), 'execution_error' (binary unreachable / spawn failed / parser unrecoverable; promoted from 'skipped' when profile.required_validators_strict lists this kind), 'skipped' (binary not on PATH and not strict; recorded for audit, does not block). finalize_stage refuses status='passed' for any artifact whose policy demands a 'verified' row that is missing or in violation/execution_error. To accept a violation, finalize the stage with status='surfaced'. Persists one row per call into artifact_validations; output_path points to the captured log.",
    schema: ArtifactValidateSchema,
    handler: async (args) => await runArtifactValidator(ArtifactValidateSchema.parse(args)),
  },
  {
    name: "get_artifact_validation",
    description:
      "Returns the latest artifact_validations row for (stage_id, validator_kind[, artifact_id]) or null. Use after artifact_validate returns to inspect status, reason, output log path, exit code, binary resolution, and duration. The driver consults this to decide whether to advance, surface, or trigger reflexion. When artifact_id is omitted the lookup ignores the artifact dimension and returns the most recent matching row.",
    schema: GetArtifactValidationSchema,
    handler: (args) => {
      const p = GetArtifactValidationSchema.parse(args);
      return { check: getLatestArtifactValidation(p.stage_id, p.validator_kind, p.artifact_id ?? null) };
    },
  },
  {
    name: "archive_winner_and_losers",
    description:
      "After a best-of-N stage picks a winner: (1) check the winner's runtime-smoke status — if status='fail' the merge is refused and merge_status='smoke_failed' is returned (override with PP_ALLOW_SMOKE_FAILED_WINNER=1); (2) auto-commit any uncommitted changes inside the winner's candidate worktree so the diff is real; (3) archive winner.diff (HEAD..branch); (4) refuse to write a 0-byte diff and return merge_status='empty' with empty_reason if HEAD == branch (engineer produced nothing); (5) git merge --no-ff the winner; (6) copy losing candidate trees to .harness/<run_id>/<kind>/losers/. Returns {winner_diff_path, losers_archived, merge_status, conflict_paths?, empty_reason?, smoke_failed_reason?}. Caller then calls teardown_candidates.",
    schema: ArchiveWinnerSchema,
    handler: async (args) => await archiveWinnerAndLosers(ArchiveWinnerSchema.parse(args)),
  },
  {
    name: "teardown_candidates",
    description:
      "Remove candidate worktrees and branches after a best-of-N stage completes. Before destroying each worktree, copies any DB-registered artifacts whose path lives inside the worktree to a sibling .harness/<run_id>/<kind>/preserved/candidate-N/ tree and rewrites the artifacts.path. If preservation fails for a candidate, that worktree is LEFT IN PLACE and the response carries teardown_status='preserve_failed' or 'partial'. Pass allow_data_loss=true to bypass preservation. Idempotent.",
    schema: TeardownCandidatesSchema,
    handler: async (args) => {
      const parsed = TeardownCandidatesSchema.parse(args);
      const result = await teardownCandidates(parsed);
      return { ok: result.teardown_status === "ok", ...result };
    },
  },
  {
    name: "get_profile",
    description:
      "Read <project>/.harness/profile.yaml. Returns the parsed profile (name + required taxonomy / rubrics / artifacts / missability checks) or null if absent.",
    schema: GetProfileSchema,
    handler: (args) => loadProjectProfile(GetProfileSchema.parse(args).project_path),
  },
  {
    name: "get_builtin_profile",
    description:
      "Return one of the 16 built-in profile templates by name, including the game-dev family. User copies this into <project>/.harness/profile.yaml to activate.",
    schema: GetBuiltinProfileSchema,
    handler: (args) => getBuiltinProfile(GetBuiltinProfileSchema.parse(args).name),
  },
  {
    name: "list_profiles",
    description: "Return the 16 built-in profile templates (id + description), including the game-dev family, so the user can pick one.",
    schema: ListProfilesSchema,
    handler: () => listBuiltinProfiles(),
  },
  {
    name: "get_claude_tier_models",
    description:
      "Return the canonical Claude tier→model-id map used by the tier-aware delegation system. Driver consumes this in /pp:run step 6a so the source of truth lives in daemon/src/config.ts (CLAUDE_TIER_MODELS). Returns { tiers: { opus, sonnet, haiku }, order: ['haiku','sonnet','opus'] }.",
    schema: GetClaudeTierModelsSchema,
    handler: () => ({ tiers: CLAUDE_TIER_MODELS, order: TIER_ORDER }),
  },
  {
    name: "get_copilot_claude_tier_models",
    description:
      "Return the GitHub Copilot-specific Claude tier→model-id map. This keeps the Copilot mirrors on their pinned model ids without changing the shared Claude Code defaults in daemon/src/config.ts. Returns { tiers: { opus, sonnet, haiku }, order: ['haiku','sonnet','opus'] }.",
    schema: GetClaudeTierModelsSchema,
    handler: () => ({ tiers: COPILOT_CLAUDE_TIER_MODELS, order: TIER_ORDER }),
  },
  {
    name: "detect_profile",
    description:
      "Sniff <project_path> for framework / packaging signals and recommend one of the 16 built-in profiles, including the game-dev family. Pure: reads files only, never writes. Returns {recommendation, confidence: 'high'|'medium'|'low'|'none', signals, alternatives}. Driver decides whether to accept; persistence happens via write_profile.",
    schema: DetectProfileSchema,
    handler: (args) => detectProfile(DetectProfileSchema.parse(args).project_path),
  },
  {
    name: "write_profile",
    description:
      "Persist a built-in profile to <project_path>/.harness/profile.yaml with a provenance header (source, ISO timestamp, optional run_id, optional signal list, hand-edit notice). source must be 'detected' or 'user-selected'. name must be one of the 16 built-in ProfileNames, including the game-dev family. Returns {path, yaml}.",
    schema: WriteProfileSchema,
    handler: (args) => {
      const parsed = WriteProfileSchema.parse(args);
      if (!(parsed.name in BUILTIN_PROFILES)) {
        throw new Error(
          `write_profile: unknown profile name "${parsed.name}". Valid names: ${Object.keys(BUILTIN_PROFILES).join(", ")}`,
        );
      }
      return writeProjectProfile(parsed.project_path, parsed.name as ProfileName, {
        source:  parsed.source,
        runId:   parsed.run_id,
        signals: parsed.signals,
      });
    },
  },
  {
    name: "get_rubric",
    description:
      "Return the markdown body and metadata for a rubric by id (e.g. 'wcag-2.2-aa@1', 'owasp-asvs-l1@1'). Used by judge agents to apply the gate's chosen rubric.",
    schema: GetRubricSchema,
    handler: (args) => getRubric(GetRubricSchema.parse(args).id),
  },
  {
    name: "list_rubrics",
    description: "List all 13 standard-aligned rubrics (id, kind, version, title, source_url) — body bytes are fetched separately via get_rubric.",
    schema: ListRubricsSchema,
    handler: () => listRubrics(),
  },
  {
    name: "team_get",
    description:
      "Resolve a team yaml by name. Resolution order: <project>/.claude/teams/ → ~/.claude/teams/ → builtin .claude/teams/. Returns {team, origin: project|user|builtin}.",
    schema: GetTeamSchema,
    handler: (args) => getTeam(GetTeamSchema.parse(args)),
  },
  {
    name: "team_list",
    description:
      "List all available teams (project + user + builtin, first-resolution wins). Returns name, description, origin, profiles_compatible, taxonomy_required.",
    schema: ListTeamsSchema,
    handler: (args) => listTeams(ListTeamsSchema.parse(args)),
  },
  {
    name: "get_design_template",
    description:
      "Returns a markdown template for a design artifact kind: 'screen_state_matrix', 'permission_aware_ux', 'localization_plan', 'responsive_matrix', or 'a11y_plan'. The designer / design-system-curator agents use this as a starting frame.",
    schema: GetDesignTemplateSchema,
    handler: (args) => getDesignTemplate(GetDesignTemplateSchema.parse(args).kind),
  },
  {
    name: "list_design_templates",
    description: "Returns the available design template kinds and their first-line headers.",
    schema: ListDesignTemplatesSchema,
    handler: () => Object.keys(TEMPLATES_BY_KIND),
  },
  {
    name: "list_forums",
    description: "List the 10 governance forums (Section 8 of taxonomy_blueprint.md): framing, scope, design, architecture, contract, threat, test-readiness, release-readiness, incident, service. Returns id, title, description, produces.",
    schema: ListForumsSchema,
    handler: () => listForums(),
  },
  {
    name: "get_forum",
    description: "Get a forum's full pipeline: id, title, description, produces, stages [{kind, gate_type, generator_agent, judge_tier, rubric_id}], required_missability_checks. The /pp:review <forum> command runs these stages.",
    schema: GetForumSchema,
    handler: (args) => getForum(GetForumSchema.parse(args).id),
  },
  {
    name: "janitor",
    description: "Run the janitor: marks runs running for >6h as 'crashed', sweeps stale candidate worktrees and branches. Returns {crashed_runs, swept_worktrees, swept_branches}. Idempotent.",
    schema: JanitorSchema,
    handler: () => runJanitor(),
  },
  {
    name: "replay",
    description: "Build a replay bundle for a run: full prompt set, model versions, CLI versions, HEAD SHA, profile, taxonomy mapping, and stage/attempt/verdict tree. Use this to re-execute the same request later in a reproducible way (no auto-execute; the driver decides).",
    schema: ReplaySchema,
    handler: (args) => buildReplayBundle(ReplaySchema.parse(args).run_id),
  },
  {
    name: "visual_regression_capture",
    description:
      "Capture before/after screenshots of the requested URLs via headless Chromium (Playwright) and save them under .harness/<run_id>/visual-regression/<phase>/. Returns {status: 'ok' | 'unavailable', files | reason}. The visual-regression-runner agent uses this on web-ui / ux-team / design-system-team pipelines.",
    schema: VisualRegressionCaptureSchema,
    handler: async (args) => await visualRegressionCapture(VisualRegressionCaptureSchema.parse(args)),
  },
  {
    name: "visual_regression_diff",
    description:
      "Compare matched before/after PNGs and emit a per-route changed-pixel ratio plus an HTML report at .harness/<run_id>/visual-regression/report.html. Returns {status, entries, report_path, worst_changed_ratio}. Run captureBefore + captureAfter first.",
    schema: VisualRegressionDiffSchema,
    handler: (args) => visualRegressionDiff(VisualRegressionDiffSchema.parse(args)),
  },
  {
    name: "browser_validation_start",
    description:
      "Allocate the per-run browser-validation artifact directory (.harness/<run_id>/browser-validation/{screenshots,console,network}) and echo back the routes + base_url the agent will use. The browser-validator agent calls this once at the start of its run, before booting the dev server and exercising the spec's acceptance criteria via either claude-in-chrome MCP (preferred) or `npx playwright test` (fallback).",
    schema: BrowserValidationStartSchema,
    handler: (args) => browserValidationStart(BrowserValidationStartSchema.parse(args)),
  },
  {
    name: "browser_validation_finalize",
    description:
      "Persist a structured findings array (route × step × status × console_errors × network_errors × screenshot_path) and render .harness/<run_id>/browser-validation/report.md. Computes severity: 'errors' if any fail/console-error/5xx; 'warnings' if any warn/4xx; 'clean' otherwise. The browser-validator agent calls this exactly once after exercising all acceptance criteria.",
    schema: BrowserValidationFinalizeSchema,
    handler: (args) => browserValidationFinalize(BrowserValidationFinalizeSchema.parse(args)),
  },
  {
    name: "retry_with_critique",
    description:
      "Reflexion ×1 retry helper. Verifies the attempt is eligible (retry_index < 1) and the run hasn't hit the loop ceiling. Returns {ok, parent_attempt_id} on success or {ok: false, reason} on rejection. The driver calls this BEFORE invoking the generator agent for the retry. The driver MUST pass parent_attempt_id back to record_attempt with retry_index=1.",
    schema: RetryWithCritiqueSchema,
    handler: (args) => {
      const parsed = RetryWithCritiqueSchema.parse(args);
      return checkRetryEligible({
        attempt_id: parsed.attempt_id,
        budget_override: parsed.budget_override,
      });
    },
  },
  {
    name: "gate_eligible_judges",
    description:
      "Given a gate_type, the generator's producer, optional prompt keywords, optional profile, and optional artifact_kind, returns the judge tier policy: required_cross_vendor (bool), base_tier, whether it was upgraded by content/profile, the reason, the recommended rubric_id, and the list of allowed judges with preferred providers. Driver MUST call this before invoking any judge.",
    schema: GateEligibleJudgesSchema,
    handler: (args) => {
      const parsed = GateEligibleJudgesSchema.parse(args);
      const decision = evaluateGate({
        gate_type:       parsed.gate_type as GateType,
        prompt_keywords: parsed.prompt_keywords,
        profile:         parsed.profile as Profile | undefined,
        artifact_kind:   parsed.artifact_kind,
      });
      const judges = listAllowedJudges(decision, parsed.generator_producer);
      return { ...decision, allowed_judges: judges };
    },
  },
];

// ─── Server ──────────────────────────────────────────────────────────────

export async function runHarnessMcpServer(): Promise<void> {
  const server = new Server(
    { name: "pp_harness", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) return errorContent(new Error(`unknown tool: ${name}`));

    try {
      // Defensive parse: some MCP clients string-serialize untyped tool params
      // and the raw `args` arrives as a JSON-encoded string instead of an
      // object. Decode here so per-tool zod schemas (e.g. tdd_pre_check) see
      // the expected object shape. On JSON.parse failure we hand the original
      // value to the schema so it surfaces a real validation error.
      let safeArgs: unknown = args ?? {};
      if (typeof safeArgs === "string") {
        try { safeArgs = JSON.parse(safeArgs); } catch { /* fall through */ }
      }
      const result = await tool.handler(safeArgs);
      log.debug({ tool: name }, "tool ok");
      return jsonContent(result);
    } catch (err) {
      log.warn({ tool: name, err }, "tool error");
      return errorContent(err);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("pp_harness MCP server running on stdio");
}
