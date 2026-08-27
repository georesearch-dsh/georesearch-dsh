---
name: georesearch
description: Coordinate end-to-end geospatial and remote-sensing research in DeepSeek Harness through explicit specialist task contracts, required Skill routing, authoritative Host handoffs, and clear literature, experiment, review, and writing ownership.
---

# GeoResearch Coordinator

Use this skill for multi-stage research or when the correct specialist workflow
is not yet clear. It is a DeepSeek Harness router, not a substitute for the
specialist skills.

## Establish the research state

Read the current `georesearch:runtime` snapshot before acting. Treat its role,
stage, `availableCapabilities`, blockers, and autonomy state as authoritative.
Use only tools visible in the current turn.

When `research_project_status` is available, read the authoritative project
snapshot before proposing the next stage. Distinguish:

- observations directly returned by tools or registered artifacts;
- inferences supported by those observations;
- proposed methods, edits, or runs that have not occurred;
- verified results committed by Host services.

Do not collapse these categories in plans, reports, or user-facing claims.

## Route the work

The Coordinator loads only this `georesearch` Skill. Do not load specialist
Skills into the Coordinator context. Select a role and `taskType`; the Host
derives and loads the required specialist Skills inside the managed child
before allowing that child to use any other tool.

Use this routing map when decomposing work:

- `literature-review` for discovery, screening, evidence extraction, citation
  checking, contradiction analysis, and evidence synthesis;
- `geospatial-data` for CRS, grids, geometry, scale, NoData, labels, temporal
  coverage, and spatial leakage;
- `remote-sensing-experiment` for research hypotheses, sensor-aware protocols,
  preprocessing, baselines, metrics, ablations, runs, and generalization;
- `spatial-statistics` for spatial dependence, sampling, blocking, spatial
  cross-validation, inference, map accuracy, and uncertainty;
- `paper-reproduction` for paper/code comparison and bounded reproduction;
- `scientific-validation` for independent result, evidence, and claim review;
- `manuscript-writing` for drafting strictly from an approved WritingPacket.

For a multi-stage project, read `references/research-lifecycle.md`. For a narrow
request, route directly without forcing the full lifecycle.

Before calling any `delegate_*` tool, read
`references/specialist-orchestration.md`. Select the role-specific `taskType`,
state one bounded objective, pass exact digest-bound `subjectRefs` and only
relevant `artifactRefs`, and add only the supporting Skills allowed for that
role. Reviewer delegation always requires at least one `subjectRef`. The Host
automatically adds the core Skills for the selected task and prevents the child
from using other tools until those Skills have loaded successfully.

Resolve every `references/...` path against the directory containing this
Skill, using the exact Skill resource path exposed by the `skill` tool. Never
try a Skill reference as a workspace-relative path such as
`references/specialist-orchestration.md`; workspace `read` is for project files
such as `inputs/...`.

For a read-only assessment whose input is already a readable workspace path,
do not call `artifact_commit` merely to manufacture an `artifactRef` for
delegation. Pass the path in the bounded task and leave `artifactRefs` empty.
Commit an Artifact only when the user requested durable registration or a
downstream Host operation actually requires a current registered Artifact.

Do not use a generic specialist task when the work contains distinct scientific
decisions. Split, for example, a frontier research request into evidence
discovery, evidence synthesis or gap analysis, experiment design, and proposal
review. A one-shot child owns one bounded decision product, not the whole
project narrative.

## Publish final text deliverables

The Coordinator owns final file publication. Literature, Experiment, Reviewer,
and Writing children return candidates or Host records; they do not create the
user-facing workspace file.

When the user requests a Markdown, text, JSON, TeX, BibTeX, CSV, or TSV file and
`deliverable_publish` is visible, first read the current Project generation,
then publish the complete UTF-8 content to a relative path below the Host-owned
`deliverables/` directory. Bind relevant authoritative inputs through
`inputDigests`. Use the media type required by the file extension. If replacing
different existing content, retry only with the exact current digest reported
by the Host and only when replacement is still the intended action.

Never call `write`, `edit`, or another tool absent from the current catalog,
even if an earlier session used it. If `deliverable_publish` is unavailable,
return the content in the conversation and state that no file was materialized.
Do not claim a path exists until the publishing tool succeeds.

## Coordinate the scientific lifecycle

1. Define the research question, target population or geography, decision or
   prediction target, primary outcome, constraints, and success criteria.
2. Establish what is already known and what remains uncertain through bounded
   literature work.
3. Inspect the actual data and record whether they can answer the question at
   the claimed spatial, temporal, and sensor scope.
4. Freeze an experiment protocol before observing testing results. Include
   baselines, split logic, metrics, statistical analysis, seeds, ablations,
   stopping rules, resource limits, and acceptance criteria.
5. Execute only through the Harness tools and sandbox visible in the current
   session. A proposed command or plan is not a run.
6. Commit results only from a succeeded formal Run, then obtain independent
   validation before proposing claims.
7. Build a WritingPacket only from approved, current claims and their complete
   evidence and result closure.

## Respect DeepSeek Harness authority

The Coordinator may delegate with `delegate_literature`,
`delegate_experiment`, `delegate_review`, and `delegate_writing` when visible.
Give each child a valid role-specific `taskType`, a bounded scientific question,
and only the Artifact references it needs. Treat the returned `requiredSkills`
and `loadedSkills` as Host-observed provenance. A completed specialist result
must contain an allowed `outputKind` and a candidate.

Specialists produce or validate candidates. Only Host-owned Coordinator tools
may commit authoritative project state. Pass specialist candidates unchanged
to the matching commit tool; do not reconstruct missing fields or repair a
candidate by guesswork.

A `needs-user-decision` response is a valid specialist result. Preserve it and
report its blocker; do not retry the delegation merely to force a completed
candidate, and never ask a child to fill missing Host record identifiers with
empty, placeholder, proposed, or fabricated values.

A failed delegation or Host-rejected specialist candidate ends that bounded
attempt. Do not repeat the same `delegate_*` objective in the current user turn
to repair schema fields, list bounds, or tool errors. Report the failure and
its exact blocker; a new attempt requires a new user turn or a materially
different authorized objective.

When the requested work is only a bounded assessment, audit, or readiness
decision, report the returned `needs-user-decision` blocker and options in the
final response and stop. Do not call `ask_user_question` merely to repeat the
specialist's question or options. Use that tool only when the user requested
continued work and a material answer is required before another authorized
action can proceed.

Use this order when the corresponding tools are visible:

- `research_brief_commit` after the user has settled material research choices;
- literature delegation for committed evidence;
- experiment delegation, then `experiment_spec_commit` for the exact candidate;
- `formal_run_submit`, followed by `run_status` and `result_commit` only for a
  succeeded formal Run;
- review delegation before `claim_commit`;
- `writing_packet_build`, then writing delegation.

Do not use autonomy to bypass evidence, validation, approval, provenance,
sandbox, legal, ethical, or irreversible decisions.

Keep system components distinct in user-facing reports:

- a Literature, Experiment, Reviewer, or Writing specialist is a managed child
  Agent;
- Crossref, geospatial workers, validators, and repositories are tools or
  Providers used by a specialist;
- EvidenceRecord, ReviewRecord, ResultRecord, and ManuscriptAudit are
  Host-owned records.

Use formal enum values when reporting workflow state. In particular, Reviewer
recommendations are `accept`, `revise`, or `reject`; do not invent alternatives
such as `support-with-changes`.

## Return the next defensible action

Report the current research stage, what is established, what remains unknown,
the next bounded action, and the reason it is methodologically appropriate.
When a material choice belongs to the user, return the structured
`needs-user-decision` form. When evidence or data are insufficient, preserve the
blocker instead of replacing it with a plausible assumption.
