export const meta = {
  name: 'pp-best-of-fanout',
  description: 'Best-of-N step 6 ONLY: dispatch N Claude engineer candidates into pre-made worktrees',
  whenToUse:
    'Opt-in replacement for step 6 of /pp:best-of (the N-candidate fan-out) and nothing else. The prose ' +
    'driver in .claude/commands/pp/best-of.md keeps steps 1-5 and 6.5-14, including smoke collection, ' +
    'diff entropy, judge routing, the second Borda lane and the smoke post-filter. NOT a best-of-N ' +
    'lifecycle: invoking this alone produces N candidates and no winner.',
  phases: [
    {
      title: 'Fan out',
      detail: 'N engineer agents, one per pre-allocated candidate worktree, model+seed varying by index',
    },
  ],
}

// NAME: `pp-best-of-fanout`, deliberately NOT `pp-best-of`.
//
// A saved workflow becomes a slash command, so `meta.name = 'pp-best-of'` would
// put `/pp-best-of` in the same autocomplete list as `/pp:best-of` — one
// character apart, and one of them runs a fan-out with no judging, no Borda and
// no winner. `-fanout` makes the scope legible at the point of invocation,
// which is the only place the mistake can be made.

// ============================================================================
// SCOPE: STEP 6 OF /pp:best-of. NOTHING ELSE.
// ============================================================================
//
// This workflow replaces exactly one step of the prose driver: the parallel
// N-candidate `engineer` dispatch and the structured collection of its results.
// It is opt-in; the prose Task-based fan-out remains the fallback and the
// default.
//
// The boundary is the whole point, and getting it wrong changes which
// candidate wins. In `.claude/commands/pp/best-of.md`:
//
//     step 6    <- THIS WORKFLOW, and only this
//     step 6.5  smoke collection      (driver)
//     step 7    diff entropy          (driver)
//     step 8    judge routing         (driver)
//     step 9    judge execution + MANDATORY second Borda lane at N>=3 (driver)
//     step 9.5  smoke post-filter     (driver)
//     step 10   archive winner/losers (driver)
//
// An earlier plan proposed absorbing "step 6 + step 8". That would have
// silently dropped 6.5, 7, 9 and 9.5 -- smoke collection, diff entropy, the
// second Borda ranking and the smoke post-filter -- every one of which can
// change the winner. Do not widen this file's remit without re-reading that
// list.
//
// WHAT THE DAEMON STILL OWNS, and this workflow must not duplicate:
// candidate worktrees, attempt slots, Borda counting, smoke persistence,
// archival, teardown. This workflow allocates nothing and decides nothing. It
// dispatches, and it reports what came back.
//
// ---------------------------------------------------------------------------
// EXPECTED `args` (pass as a real JSON object, never a JSON-encoded string):
//
//   {
//     run_id:       "run_...",           // from start_run
//     stage_id:     "stage_...",         // from start_best_of_stage
//     request_text: "...",               // the user's request, minus CLI flags
//     candidates: [                      // VERBATIM from start_best_of_stage
//       { candidate_index: 1, attempt_slot_id: "...", worktree_path: "..." },
//       ...
//     ],
//     agents_md_path?:      "<project>/AGENTS.md",
//     runtime_smoke_test?:  <profile.runtime_smoke_test, forwarded as-is>,
//     do_not_touch?:        ["path/one", "path/two"]
//   }
//
// `candidates` MUST be the daemon's own array. Do not renumber, sort, filter or
// re-derive it: `attempt_slot_id` and `candidate_index` are the daemon's keys
// for the attempt rows and for `stages.notes_json.smoke_results`, and a
// re-derived index silently writes a candidate's smoke status onto a different
// candidate's slot.
// ---------------------------------------------------------------------------

// The model/seed rotation from best-of.md step 6, as data. Index-addressed and
// cycled, so it is fully deterministic: `Math.random()` throws in a workflow
// script, and diversity here comes from the seed/model mix rather than from
// sampling entropy.
//
// ONE model field, not two. Verified against the subagent docs: a subagent
// `model` accepts a full model ID as well as an alias — "use a full model ID
// such as `claude-opus-5` or `claude-sonnet-5`. Accepts the same values as the
// `--model` flag". So the same string can both dispatch the agent and be
// recorded on `record_attempt`, and there is no way for the dispatched model
// and the ledgered model to disagree.
//
// `tier` is a genuinely separate concept — the coarse label `record_attempt`
// stores as `attempted_tier` for cost-by-tier analytics — so it stays its own
// field rather than being parsed back out of the model id.
const ROTATION = [
  { model: 'claude-sonnet-5', tier: 'sonnet', seed: 'primary' },
  { model: 'claude-opus-5', tier: 'opus', seed: 'primary' },
  { model: 'claude-sonnet-5', tier: 'sonnet', seed: 'devils-advocate' },
  { model: 'claude-opus-5', tier: 'opus', seed: 'terse-diff' },
  { model: 'claude-sonnet-5', tier: 'sonnet', seed: 'failing-test-first' },
  { model: 'claude-opus-5', tier: 'opus', seed: 'devils-advocate' },
  { model: 'claude-sonnet-5', tier: 'sonnet', seed: 'terse-diff' },
  { model: 'claude-opus-5', tier: 'opus', seed: 'failing-test-first' },
]

// The engineer's documented return contract (engineer.md, Path A step 7).
// Declared as a schema rather than parsed out of prose: `smoke_status` decides
// whether step 9.5 overrides the rubric winner and whether step 13 triggers
// Reflexion, so it must arrive as a validated value, not as something read out
// of a paragraph.
const CANDIDATE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    attempt_id: { type: 'string', description: 'from record_attempt' },
    candidate_index: { type: 'number', description: 'echo the candidate_index you were given' },
    model_id: { type: 'string', description: 'the exact model id you recorded on record_attempt' },
    artifact_summary: { type: 'string', description: 'at most 5 bullets' },
    smoke_status: {
      type: 'string',
      enum: ['pass', 'fail', 'infra_error', 'skipped'],
      description: 'the same value you passed to record_smoke_status',
    },
    smoke_reason: { type: 'string', description: 'set when smoke_status is fail or infra_error' },
    committed: { type: 'boolean', description: 'true if you committed inside the worktree' },
    findings_closed: { type: 'array', items: { type: 'object' } },
    findings_unaddressed: { type: 'array', items: { type: 'object' } },
    anti_pattern_hits: { type: 'array', items: { type: 'object' } },
  },
  // `required` MUST be a subset of what engineer.md's Path A step 7 actually
  // promises to return. A schema that demands more than the agent's own
  // contract offers fails validation, and a failed validation surfaces as
  // `agent()` returning null — so an over-demanding schema would turn EVERY
  // candidate into a dispatch failure, with the cause visible nowhere except
  // the schema. The cross-vendor judge caught exactly that here: an earlier
  // version required `committed`, which step 7 does not list.
  //
  // Two fields are deliberately NOT required despite being useful:
  //   `committed`  — not in the contract at all. The prompt asks for it and it
  //                  is read when present; its absence is informative, not fatal.
  //   `attempt_id` — in the contract, but an engineer that fails before
  //                  `record_attempt` has none. Requiring it would convert a
  //                  reportable error into a null, which is the same defect in
  //                  a different place.
  //
  // `daemon/test/workflow-scripts.unit.mjs` asserts this subset relation against
  // engineer.md, so the next person to add a field is told by a test rather than
  // by a judge.
  required: ['candidate_index', 'model_id', 'artifact_summary', 'smoke_status'],
}

function buildPrompt(cand, rot, a) {
  // Everything the engineer needs, named exactly as engineer.md's "Inputs"
  // section names it. The typed agent already carries its own procedure; this
  // prompt supplies inputs, it does not restate the protocol.
  const lines = [
    'You are dispatched as one candidate of a pair-programmer best-of-N code stage.',
    'Follow your own Path A procedure (producer="claude") exactly, including step 3.5',
    '(runtime smoke test), step 4 (commit inside the worktree) and step 4.5 (self-verification).',
    '',
    '## Inputs',
    '',
    '- run_id: ' + a.run_id,
    '- stage_id: ' + a.stage_id,
    '- producer: "claude"',
    '- model: ' + rot.model,
    '- attempted_tier: "' + rot.tier + '"',
    '- seed: "' + rot.seed + '"',
    '- candidate_index: ' + cand.candidate_index,
    '- attempt_slot_id: ' + cand.attempt_slot_id,
    '- cwd: ' + cand.worktree_path,
  ]

  if (a.agents_md_path) lines.push('- agents_md_path: ' + a.agents_md_path)
  if (a.runtime_smoke_test !== undefined) {
    lines.push('- profile.runtime_smoke_test: ' + JSON.stringify(a.runtime_smoke_test))
  }
  if (Array.isArray(a.do_not_touch) && a.do_not_touch.length) {
    lines.push('- do_not_touch: ' + JSON.stringify(a.do_not_touch))
  }

  lines.push(
    '',
    '## Request',
    '',
    a.request_text,
    '',
    '## Non-negotiable',
    '',
    '- Write ONLY inside `cwd` (' + cand.worktree_path + '). It is a git worktree the daemon',
    '  created for you; `archive_winner_and_losers` merges it back from there. Writing outside it',
    '  puts your work somewhere the merge cannot find.',
    '- Pass `attempt_slot_id` to `record_attempt` so the daemon links the attempt to this slot.',
    '- Call `record_smoke_status` with `candidate_index: ' + cand.candidate_index + '` and report the',
    '  SAME value back in `smoke_status`. The daemon\'s row is authoritative; your return value is',
    '  what the driver reads to build the report and to decide the smoke post-filter, so a',
    '  disagreement between the two is a defect, not a rounding difference.',
    '- Commit before returning, whatever the smoke outcome. The judge ranks the diff, so an',
    '  uncommitted worktree is an unjudgeable candidate.',
    '- Do NOT call `archive_artifact` with any path inside this worktree; the daemon rejects it.',
    '- Do NOT read the other candidates\' worktrees. Candidate independence is what best-of-N',
    '  measures; cross-reading collapses the ensemble into one opinion wearing N hats.',
  )

  return lines.join('\n')
}

// ---------------------------------------------------------------------------

const a = args || {}
const candidates = Array.isArray(a.candidates) ? a.candidates : []

// Fail loudly on a malformed call rather than fanning out a partial ensemble.
// N is load-bearing downstream: at N>=3 a second Borda lane is MANDATORY, and
// Borda over a silently-shortened field elects a different winner.
if (!a.run_id || !a.stage_id || !a.request_text) {
  throw new Error(
    'pp-best-of: args must carry run_id, stage_id and request_text. ' +
      'Got keys: [' + Object.keys(a).join(', ') + ']',
  )
}
if (candidates.length < 2 || candidates.length > 8) {
  throw new Error(
    'pp-best-of: expected 2-8 candidates from start_best_of_stage, got ' + candidates.length +
      '. Pass the daemon\'s `candidates` array verbatim.',
  )
}
for (const c of candidates) {
  if (typeof c.candidate_index !== 'number' || !c.attempt_slot_id || !c.worktree_path) {
    throw new Error(
      'pp-best-of: every candidate needs candidate_index, attempt_slot_id and worktree_path. ' +
        'Offending entry: ' + JSON.stringify(c),
    )
  }
}

phase('Fan out')
log(
  'Dispatching ' + candidates.length + ' Claude candidates for stage ' + a.stage_id +
    ' (step 6 only -- smoke collection, entropy, judging and Borda stay with the prose driver)',
)

// A BARRIER IS CORRECT HERE, and this is the one place in this file where the
// "default to pipeline()" guidance does not apply.
//
// Step 6 is a single stage, and its consumer needs the whole set at once:
// step 6.5 builds a candidate_index -> smoke map over ALL N, step 7 computes
// diff entropy across ALL N candidate texts, and step 9 ranks ALL N. There is
// no second stage inside this workflow for an early finisher to advance into,
// so `parallel()` costs nothing that `pipeline()` would save. The workflow
// boundary IS the barrier.
//
// NOTE ON isolation: deliberately NOT `isolation: 'worktree'`. The daemon
// already created a git worktree per candidate and handed us its path; letting
// the workflow create its own would put each engineer in a DIFFERENT directory
// from the branch `archive_winner_and_losers` merges, and the run would end
// with an empty winner.diff and no obvious cause.
const settled = await parallel(
  candidates.map((cand, i) => {
    const rot = ROTATION[i % ROTATION.length]
    return () =>
      agent(buildPrompt(cand, rot, a), {
        label: 'candidate-' + cand.candidate_index + ' (' + rot.tier + '/' + rot.seed + ')',
        phase: 'Fan out',
        agentType: 'engineer',
        model: rot.model,
        schema: CANDIDATE_RESULT_SCHEMA,
      })
  }),
)

// NULL IS NOT ABSENCE. `agent()` returns null when the user skips it mid-run or
// the subagent dies on a terminal error. Dropping those with .filter(Boolean)
// would hand the driver a SHORTER candidate list than the daemon allocated
// slots for -- which changes N, changes whether the second Borda lane is
// mandatory, and changes the winner, all without an error anywhere.
//
// So every null becomes an explicit infra_error row carrying its
// candidate_index. Step 6.5's documented fallback then fires
// `record_smoke_status({status: "infra_error"})` for it, the slot stays in the
// ledger, and the report shows a dispatch failure instead of quietly electing
// a winner from a thinner field.
const results = candidates.map((cand, i) => {
  const rot = ROTATION[i % ROTATION.length]
  const r = settled[i]

  if (!r) {
    return {
      candidate_index: cand.candidate_index,
      attempt_slot_id: cand.attempt_slot_id,
      worktree_path: cand.worktree_path,
      model_id: rot.model,
      attempted_tier: rot.tier,
      seed: rot.seed,
      dispatch: 'failed',
      smoke_status: 'infra_error',
      smoke_reason: 'workflow_dispatch_failed: agent returned no result (skipped or terminal error)',
      committed: false,
      artifact_summary: 'no result returned from the engineer agent',
    }
  }

  // The daemon's candidate_index wins over the agent's echo of it. If the agent
  // echoed a different one, that is worth surfacing rather than trusting: it
  // means smoke status may have been recorded against the wrong slot.
  const echo_mismatch =
    typeof r.candidate_index === 'number' && r.candidate_index !== cand.candidate_index

  return {
    ...r,
    candidate_index: cand.candidate_index,
    attempt_slot_id: cand.attempt_slot_id,
    worktree_path: cand.worktree_path,
    attempted_tier: rot.tier,
    seed: rot.seed,
    dispatch: 'ok',
    ...(echo_mismatch
      ? {
          index_echo_mismatch:
            'engineer echoed candidate_index=' + r.candidate_index + ' but was dispatched as ' +
            cand.candidate_index + ' -- verify record_smoke_status landed on the right slot',
        }
      : {}),
  }
})

const failed = results.filter(r => r.dispatch === 'failed')
if (failed.length) {
  // No silent caps: say what was lost, in the narrator line the operator sees.
  log(
    'WARNING: ' + failed.length + ' of ' + candidates.length + ' candidates failed to dispatch (' +
      failed.map(r => 'c' + r.candidate_index).join(', ') +
      '). They are reported as infra_error, NOT dropped -- step 6.5 must record their status so N ' +
      'and the Borda field stay intact.',
  )
}

const mismatched = results.filter(r => r.index_echo_mismatch)
if (mismatched.length) {
  log('WARNING: candidate_index echo mismatch on ' + mismatched.map(r => 'c' + r.candidate_index).join(', '))
}

log(
  'Fan-out complete: ' + results.filter(r => r.dispatch === 'ok').length + '/' + candidates.length +
    ' dispatched; smoke ' +
    ['pass', 'fail', 'infra_error', 'skipped']
      .map(s => s + '=' + results.filter(r => r.smoke_status === s).length)
      .join(' ') +
    '. Returning to the prose driver at step 6.5.',
)

// The return value is the driver's step-6 output. `smoke_summary` is
// pre-shaped as step 6.5 expects it so the driver does not have to re-derive a
// map and risk keying it differently.
return {
  step: 6,
  next_driver_step: 6.5,
  run_id: a.run_id,
  stage_id: a.stage_id,
  n: candidates.length,
  candidates: results,
  smoke_summary: results.reduce((acc, r) => {
    acc[r.candidate_index] = { smoke_status: r.smoke_status, smoke_reason: r.smoke_reason || null }
    return acc
  }, {}),
  dispatch_failures: failed.map(r => r.candidate_index),
  index_echo_mismatches: mismatched.map(r => r.candidate_index),
  // Explicit, so a future reader does not have to infer the boundary from the
  // absence of code.
  not_done_here: [
    '6.5 smoke collection (driver: read smoke_summary above; fall back to record_smoke_status for any dispatch_failure)',
    '7 diff entropy across the N worktrees',
    '8 judge routing via judge-router',
    '9 judge execution + MANDATORY second Borda lane at n>=3',
    '9.5 smoke post-filter (may override the rubric winner)',
    '10 archive_winner_and_losers',
    '11 teardown_candidates',
  ],
}
