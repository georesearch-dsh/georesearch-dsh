# Computational Reproduction Protocol

Use this reference to plan and classify a reproduction without overstating the
outcome.

## Reproduction scope

Choose the narrowest scope that answers the user's question:

| Scope | Target |
|---|---|
| Exact | Same implementation identity, data, configuration, and materially equivalent environment |
| Metric-equivalent | Prespecified metrics agree within justified tolerance |
| Functional | The released workflow performs the same declared function |
| Conceptual | An independently implemented method supports the same concept |
| Partial | Only a declared subset of claims or components is addressed |

Do not change scope after observing an unfavorable result without reporting the
change.

## Target matrix

For each target, record:

- paper locator: page, section, equation, table, or figure;
- claimed method and result;
- code locator and repository revision;
- required dataset, version, split, and preprocessing;
- required checkpoint or model artifact;
- configuration and random seed;
- metric implementation and aggregation;
- expected value or qualitative behavior;
- tolerance and reason;
- observable output artifact.

One reproduction may contain several targets with different outcomes.

## Baseline audit

The baseline audit should establish:

- repository identity, branch, commit, dirty state, and source-tree digest;
- submodules, large-file dependencies, generated code, and external downloads;
- environment declarations and unsupported or conflicting versions;
- documented entrypoints and actual entrypoints;
- defaults that materially affect results;
- paper-method/code classifications: matches, partially matches, differs,
  missing in code, not described in paper, or unclear.

Do not edit before this audit. Otherwise the original implementation and the
local intervention cannot be distinguished.

## Data and artifact availability

Check:

- whether the data are public, restricted, transformed, or unavailable;
- checksums, version, license, and expected directory layout;
- whether splits are released or reconstructed;
- whether preprocessing outputs or labels are missing;
- whether pretrained weights, calibration files, or external services are
  required;
- whether a substitute changes the scientific target.

Missing target data is not repaired by using a convenient alternative and
retaining the original claim.

## Environment reconstruction

Record:

- operating system and architecture;
- runtime and package-manager versions;
- dependency lock state;
- accelerator, driver, and numerical-library requirements;
- environment variables and credential references without exposing secrets;
- nondeterministic operations and reproducibility settings;
- resource and time requirements.

Classify every environment change as necessary, optional, or exploratory.

## Execution strategy

Use the smallest execution that can falsify or support the target:

1. verify static identity and required files;
2. run registered code-quality or unit checks when informative;
3. execute a small scientifically valid subset if the plan permits it;
4. execute the complete target through a formal Run when required;
5. compare produced artifacts and metrics against prespecified criteria.

A smoke test can establish that software starts; it cannot establish that the
scientific result is reproduced.

## Difference diagnosis

Classify differences before proposing fixes:

- paper and code specify different methods;
- data or split identity differs;
- preprocessing or metric implementation differs;
- configuration default differs;
- random or numerical variation;
- dependency or hardware sensitivity;
- missing external artifact;
- local modification;
- execution failure with a known cause;
- unresolved discrepancy.

Prefer one change at a time when diagnosing. Preserve the baseline and every
later audit so each result remains attributable.

## Outcome classification

Use the repository's exact report statuses:

- exactly-reproduced;
- metric-equivalent;
- functionally-reproduced;
- conceptually-reproduced;
- partially-reproduced;
- blocked-by-missing-data;
- blocked-by-environment;
- failed-with-diagnosis.

Exactly-reproduced requires an unchanged baseline source tree and established
target inputs. Metric-equivalent requires prespecified metrics and tolerance.
Blocked and failed outcomes are valid research results and must not be rewritten
as partial success.

## Report contents

The report should include the target, paper description, official code
behavior, local environment, baseline and final audits, necessary modifications,
runs, metric comparisons, result differences, likely sources, diagnostics,
unresolved details, and limitations.
