---
name: spatial-statistics
description: Design, execute, and review spatial statistical analysis in DeepSeek Harness, including sampling, spatial dependence, blocking, spatial cross-validation, inference, map accuracy, uncertainty, and defensible reporting.
---

# Spatial Statistics

Use this skill when location, neighborhood, distance, spatial support, or
regional structure affects sampling, validation, inference, prediction, or
uncertainty. It supports both the Experiment and Reviewer roles.

Follow the active specialist ownership boundary. In an Experiment task, use
this Skill to design sampling, validation, inference, and uncertainty. In a
Reviewer task, use it to assess those choices independently without repairing
the subject. In Literature work, use it only to compare published methods or
identify evidence gaps.

## Define the spatial question

First determine whether the task is:

- descriptive mapping or cluster detection;
- estimation for a finite area or population;
- testing an association or spatial pattern;
- predictive modeling and out-of-sample generalization;
- causal analysis with spatially structured exposure or confounding;
- change detection or spatiotemporal inference.

State the observational unit, spatial support, target population or region,
time support, estimand or prediction target, and intended generalization. A
method is not appropriate merely because the data have coordinates.

For method selection, diagnostics, and reporting details, read
`references/spatial-methods.md`.

## Establish spatial identity and sampling

Load `geospatial-data` and verify CRS, units, geometry or raster support,
resolution, extent, sampling frame, inclusion probabilities when relevant,
missing coverage, and temporal alignment.

Identify dependence introduced by shared scenes, tiles, plots, objects,
households, administrative units, acquisition dates, preprocessing, or labels.
Do not equate a large pixel count with a large independent sample size.

Define the spatial weights, neighborhood, distance threshold, kernel, graph, or
block construction from scientific reasoning and the sampling process. Do not
try many definitions and report only the most favorable one.

## Diagnose dependence before choosing inference

Use global diagnostics for overall residual or variable structure and local
diagnostics only when local clusters are scientifically relevant. Consider
Moran's I, Geary's C, variograms, correlograms, residual maps, or comparable
diagnostics according to data type and model.

Diagnostics on the raw outcome do not replace diagnostics on model residuals.
Statistical significance from a local statistic requires multiplicity control
or an explicitly justified inferential procedure.

## Match design and validation to the claim

For prediction, choose resampling that represents deployment:

- grouped splits for shared objects, scenes, plots, or acquisition units;
- spatial blocks or buffered leave-location-out for new nearby locations;
- leave-region-out for transfer to new regions;
- temporal or spatiotemporal blocking for future periods;
- sensor- or domain-held-out evaluation for cross-sensor transfer.

Choose block size from the dependence range, sampling design, operational
deployment unit, and data availability. Record sensitivity to defensible block
definitions. Random cross-validation may estimate interpolation performance but
must not be labeled spatial transfer performance.

For estimation or inference, choose a design- or model-based approach that
matches the sampling mechanism and dependence. Consider cluster or spatial
bootstrap, permutation under an appropriate null, spatial covariance models,
SAR/SEM/CAR models, Gaussian processes, or spatial random effects only when
their assumptions and estimand fit the question. Treat geographically weighted
regression primarily as local exploratory modeling unless a stronger design is
justified.

## Handle remote-sensing accuracy correctly

For classified maps, distinguish model validation samples from a probability
sample intended to estimate map accuracy or area. Report the sampling design,
response design, error matrix, class-specific user's and producer's accuracy,
overall accuracy, uncertainty, and area-adjusted estimates when the sampling
design requires them.

Pixel-level accuracy alone does not establish object-, scene-, region-, or
area-level performance. For continuous maps, report error distributions and
spatial structure, not only a global RMSE or correlation.

## Use DeepSeek Harness tools

When visible:

1. use `geodata_inspect` to record declared blocking, autocorrelation,
   multiplicity, effect-size, CRS, alignment, NoData, and leakage controls;
2. encode the chosen method, confidence level, effect size, multiple-comparison
   procedure, spatial-autocorrelation treatment, and blocking strategy in
   `experiment_spec_candidate`;
3. implement analysis code only with the Experiment role's `read`, `write`, and
   `edit` tools inside the bound workspace;
4. use a Host-registered TestSpec only for supported test runners, and use
   `formal_run_candidate` for the actual source-, dataset-, environment-, seed-,
   and protocol-bound scientific execution;
5. in the Reviewer role, use `result_read`, `geodata_validate`, and
   `experiment_validate` before interpreting spatial claims.

Never claim that Moran's I, a variogram, a spatial model, confidence interval,
or area-adjusted accuracy was calculated unless a visible tool or committed
artifact contains that output.

## Interpret and report

Report the estimand or prediction target, spatial unit, weights or blocks,
dependence diagnostics, model or resampling method, effect size, uncertainty,
multiplicity procedure, sensitivity analyses, residual spatial structure, and
geographic limits of inference.

Use `blocked` when coordinates, CRS, sampling units, spatial support, sampling
design, or raw information needed for the claimed statistic cannot be
established. Prefer a narrower supported conclusion to an apparently precise
but spatially invalid result.
