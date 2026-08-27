---
name: paper-reproduction
description: Reproduce or audit a published computational study in DeepSeek Harness by separating paper claims, repository behavior, data, environment, execution, and bounded evidence of agreement or failure.
---

# Paper Reproduction

Use this skill when a paper, repository, released model, or published result
must be reproduced or compared with local behavior.

This is the core Skill for Experiment `reproduction` and a supporting Skill for
Reviewer `reproduction-review`. The Experiment specialist may audit, plan,
perform bounded implementation, and propose runs. The Reviewer remains
read-only and assesses the resulting lineage and diagnosis. Neither role may
upgrade a blocked, modified, partial, or negative outcome into exact success.

## Define the reproduction target

State the exact target before changing code:

- the paper claim, table, figure, metric, or artifact to reproduce;
- whether the goal is repeatability with the authors' materials, computational
  reproducibility in a new environment, robustness analysis, or independent
  replication with new data;
- the quantitative and qualitative acceptance criteria;
- the allowed differences in hardware, dependency versions, random variation,
  data availability, and preprocessing.

Do not label a partial rerun or conceptual similarity as exact reproduction.
For a detailed protocol and outcome taxonomy, read
`references/reproduction-protocol.md`.

## Separate the sources of truth

Keep distinct:

- what the paper states;
- what supplementary material states;
- what the repository revision implements;
- what released data and checkpoints contain;
- what the local environment can execute;
- what an actual Harness Run observed.

Do not assume that paper, code, configuration defaults, pretrained weights,
and release artifacts agree.

## Audit before editing

Use `repository_audit` before planning. Record the exact repository revision,
source-tree digest, environment files, entrypoints, configuration, data
expectations, random seeds, and paper-method/code deltas.

Bind `reproduction_plan_candidate` to that baseline audit. The plan must list
ordered steps, expected artifacts, checkpoints, acceptance criteria, and
diagnostics for missing data, dependencies, hardware, credentials, or ambiguous
methods.

After any workspace modification, create a new `repository_audit`. Bind each
`test_spec_candidate` to the exact later audit and source tree it tests.
Dynamic TestSpecs must use an approved runner and cannot introduce a smoke or
generic shell entrypoint.

## Execute bounded checks

Use `local_test_run` only for Host-registered TestSpecs. Use
`formal_run_candidate` when a source-, environment-, dataset-, seed-, and
protocol-bound formal execution is required; the Coordinator owns submission.

For each execution, preserve:

- exact inputs, versions, configuration, seed, and environment;
- stdout, stderr, exit state, artifacts, and resource limits returned by the
  Harness;
- deviations from the paper and why they were necessary;
- whether a difference is numerical tolerance, stochastic variation,
  environment sensitivity, implementation divergence, missing prerequisite, or
  unresolved error.

A command that was not executed is a proposal, not a run.

## Classify the outcome conservatively

Before constructing a ReproductionReport Candidate, verify that its `planId`,
`baselineAuditId`, and `finalAuditId` name authoritative records available in
the Host project. If an assessment-only task lacks any of those records, or the
visible tools cannot create them from actual materials, return the structured
`needs-user-decision` result with the missing prerequisites and the blocked
readiness conclusion. Never invent `planId`, `baselineAuditId`, or
`finalAuditId`, never use empty strings, and never label a proposed identifier
as though it were a Host record.

Return a strict ReproductionReport Candidate that distinguishes the paper,
official code behavior, local implementation and environment, necessary
changes, observed results, differences, likely sources, unresolved details,
and limitations.

The candidate contains exactly `schemaVersion: 1`, `kind:
reproduction-report`, `planId`, `baselineAuditId`, `finalAuditId`, `runIds`,
`status`, `metricResults`, `paperDescription`, `officialCodeBehavior`,
`localImplementationAndEnvironment`, `necessaryModifications`,
`resultDifferences`, `differenceSources`, `unresolvedDetails`, `diagnostics`,
and `limitations`. A metric result contains exactly `resultId`, nullable
`expectedValue`, nullable `observedValue`, nullable `unit`, and `comparison`
(`match`, `within-tolerance`, `different`, or `unavailable`). A modification
contains exactly `path`, `description`, and `reason`; a diagnostic contains
exactly `code`, `message`, `relatedRunIds`, and `relatedArtifactIds`.

`status` must be one of `exactly-reproduced`, `metric-equivalent`,
`functionally-reproduced`, `conceptually-reproduced`, `partially-reproduced`,
`blocked-by-missing-data`, `blocked-by-environment`, or
`failed-with-diagnosis`. Include every list field even when empty and do not add
fields; the Host commits the candidate only after strict parsing.

Preserve negative findings and partial results. Never rewrite them into success.
Never claim `exactly-reproduced` after the baseline source tree was modified or
when the target data, weights, configuration, or metric implementation could
not be established.
