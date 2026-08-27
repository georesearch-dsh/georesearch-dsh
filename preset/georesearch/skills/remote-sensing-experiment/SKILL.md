---
name: remote-sensing-experiment
description: Design and execute defensible remote-sensing experiments in DeepSeek Harness, from hypotheses and sensor-aware data preparation through baselines, splits, metrics, statistical analysis, runs, and generalization claims.
---

# Remote-Sensing Experiment

Use this skill for a new experiment, protocol review, model comparison, or
analysis plan involving Earth-observation data. Work as the experiment
specialist when that role is active; return candidates for Host-owned
Coordinator commits.

## Specialist ownership

When loaded by the Experiment specialist, follow the Host-declared `taskType`
and allowed `outputKind`. Own data fitness, protocol design, bounded
implementation, reproduction, and run preparation. Do not claim comprehensive
literature coverage, independently approve the work, approve Claims, or write
the manuscript.

Use `geospatial-data` for spatial identity and measurement support,
`spatial-statistics` for dependence, sampling, validation, and uncertainty, and
`paper-reproduction` when an existing publication or repository is the target.
The Host task contract determines which of these are required before other
tools may run.

## Formulate the scientific question

State the scientific or operational question before selecting a model. Define:

- the target phenomenon, population, geography, period, and spatial support;
- the prediction target, estimand, or comparison and its unit of analysis;
- falsifiable hypotheses and the primary outcome;
- the generalization claim: new pixels, scenes, dates, regions, sensors,
  domains, or populations;
- practical constraints, failure costs, compute limits, and acceptance criteria.

Do not convert an exploratory objective into a confirmatory claim after seeing
the results.

For detailed sensor branches, protocol fields, and design decisions, read
`references/experiment-design.md`.

## Establish data suitability

Record product and sensor versions, acquisition dates, orbits or viewing
geometry when relevant, processing levels, quality masks, clouds and shadows,
terrain effects, calibration, speckle treatment, tiling, labels, and reference
data quality.

Use `geodata_inspect` before `experiment_spec_candidate` when the registered
datasets are available. Load `geospatial-data` for compatibility and leakage
issues and `spatial-statistics` when dependence, spatial sampling, spatial
cross-validation, map accuracy, or spatial inference affects the claim.

## Design the protocol before testing

Specify:

- dataset roles and immutable training, validation, testing, and holdout units;
- split units and buffers that match the generalization claim;
- preprocessing fitted only on permitted training data;
- physically or operationally meaningful baselines;
- independent variables, controls, seeds, ablations, and stopping rules;
- primary and secondary metrics with units, direction, aggregation, and exact
  implementation references;
- statistical method, effect size, confidence level, multiple-comparison
  control, spatial autocorrelation handling, and blocking strategy;
- resource requirements and success, equivalence, or non-inferiority criteria.

Spatially adjacent, temporally overlapping, object-related, or same-scene
samples are not independent by default. Random pixel splits are not evidence of
regional generalization.

Report class imbalance, invalid pixels, missing observations, and whether each
metric is macro, micro, weighted, per-class, per-object, per-scene, per-area,
or per-pixel. Accuracy without a declared sampling and aggregation unit is
ambiguous.

## Use DeepSeek Harness tools in sequence

Use only visible capabilities:

1. Inspect registered datasets with `geodata_inspect`.
2. Use `experiment_spec_candidate` to validate the complete protocol without
   committing it.
3. When code must change, use `read`, `write`, and `edit` only inside the bound
   workspace. Preserve a clean repository audit when reproduction is involved.
4. Use `test_spec_candidate` and `local_test_run` only for Host-approved test
   runners and registered test entrypoints; do not smuggle arbitrary shell
   commands into a TestSpec.
5. Use `formal_run_candidate` for the exact source-, dataset-, environment-,
   seed-, resource-, and ExperimentSpec-bound execution plan.
6. Return the exact candidates to the Coordinator. Only the Coordinator may use
   `experiment_spec_commit`, `formal_run_submit`, and `result_commit`.

A candidate, proposed command, edited script, or successful local test is not a
formal scientific result. A formal result exists only after a succeeded formal
Run and Host-derived ResultRecords.

## Analyze without moving the goalposts

Compare the primary outcome first. Report effect size and uncertainty, not only
rank or statistical significance. Separate confirmatory results from secondary,
subgroup, ablation, and exploratory findings. Preserve failed runs, negative
results, below-baseline results, and assumption violations.

Do not tune on testing data. If the protocol must change after any result is
observed, create an explicit amendment with the observed run identifiers and
interpret the later result accordingly.

## Return an experiment candidate

For `data-fitness-report` or `implementation-report`, use the standard report
candidate with exactly `schemaVersion: 1`, `kind` equal to the selected
`outputKind`, non-empty `methods`, non-empty `findings`, `limitations`,
`recommendations`, `subjectRefs`, and `artifactRefs`. Each finding contains
exactly `findingId`, `statement`, `basisRefs`, `confidence` (`high`,
`moderate`, `low`, or `unknown`), and `limitations`; include every list even
when it is empty. Keep the candidate compact: at most four methods, four
findings, four top-level limitations, and four recommendations. Each finding
may contain at most eight `basisRefs` and four finding-level limitations;
`subjectRefs` and `artifactRefs` may contain at most eight entries each. Keep
every method, finding statement, limitation, and recommendation under 1000
characters and every `basisRef` under 400 characters.

Before calling `structured_output`, self-check every required top-level field,
every finding's exact keys, all enum values, and every list bound. Call
`structured_output` exactly once with strict JSON whose only top-level property
is `result`: `{"result": <completed-or-needs-user-decision object>}`. Pass the
`result` value as the object itself, never as JSON text. Do not add an
`arguments` or `value` wrapper, do not emit trailing commas, and do not use a
rejected call as schema feedback.

For `experiment-spec-candidate` and `formal-run-candidate`, return the exact
candidate accepted or produced by the matching candidate tool. Do not add
convenience fields: the Host parser remains authoritative after
`structured_output`.

Return a complete protocol or bounded execution candidate containing the
research question, hypotheses, datasets, splits, preprocessing, baselines,
metrics, statistical plan, seeds, ablations, stopping rule, resources,
acceptance criteria, expected artifacts, and unresolved blockers. Do not claim
that an experiment ran unless a Harness tool returned its RunRecord.
