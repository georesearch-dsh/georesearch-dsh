# Remote-Sensing Experiment Design

Use this reference when constructing an ExperimentSpecCandidate or reviewing a
remote-sensing protocol.

## 1. Question, estimand, and generalization

Separate common objectives:

- classification or detection of a target at a declared unit;
- continuous-variable estimation;
- change detection;
- forecasting;
- domain, region, or sensor transfer;
- causal or policy-effect estimation;
- physical parameter retrieval.

Define what one prediction represents and what population or region the summary
metric estimates. The same model can require different designs for
interpolation within known scenes and transfer to new regions.

Write hypotheses so an unfavorable outcome remains interpretable. Identify one
primary outcome and predeclare whether the study seeks superiority,
non-inferiority, equivalence, calibration, or descriptive characterization.

## 2. Sensor-aware data decisions

### Optical and multispectral

Record atmospheric correction, surface or top-of-atmosphere reflectance,
cloud, shadow, snow and saturation masks, sun-view geometry, BRDF or terrain
effects, compositing, and spectral response differences. Fit normalization and
composite thresholds without using testing outcomes.

### SAR

Record acquisition mode, orbit direction, polarization, radiometric
calibration, terrain correction, incidence angle, speckle filtering, geometric
distortion, and whether values are linear power or decibels. Avoid averaging or
modeling in the wrong scale.

### LiDAR

Record acquisition density, scan geometry, ground classification, vertical
datum, normalization, canopy or object metrics, footprint, and coverage gaps.
Separate point-, voxel-, object-, and plot-level targets.

### Hyperspectral

Record radiometric and atmospheric correction, noisy or water-absorption band
handling, spectral response, dimensionality reduction, spatial-spectral
leakage, and whether preprocessing was fitted only on training data.

### Time series

Record acquisition cadence, irregular gaps, compositing, phenological phase,
temporal leakage, change-point definition, and whether deployment predicts the
future or interpolates missing observations.

### Multi-sensor fusion

Record temporal matching tolerance, spatial support, co-registration,
resampling, missing-sensor policy, harmonization, and a baseline for each
single-sensor source.

## 3. Sampling and splits

Select the split unit from the deployment claim:

| Claim | Candidate evaluation design |
|---|---|
| New samples within known scenes | grouped sampling within scene, with object independence |
| New scenes in the same region | scene-held-out evaluation |
| New nearby locations | buffered or blocked spatial validation |
| New regions | leave-region-out or geographically external test |
| Future dates | temporal holdout with no future-derived preprocessing |
| New sensors or products | sensor- or product-held-out evaluation |

Keep test and final holdout units immutable. Ensure tiling, augmentation,
feature extraction, normalization, imputation, and label generation do not
cross split roles.

For accuracy or area estimation, distinguish a convenience model-validation
sample from a probability sample representing the target map or population.

## 4. Baselines and controls

Include:

- a simple data-informed baseline;
- the strongest relevant published or operational baseline that can be fairly
  implemented;
- sensor-only or feature-family baselines for fusion studies;
- persistence, climatology, majority-class, or physical baselines when
  meaningful;
- ablations that isolate the claimed contribution.

Keep training budget, input information, hyperparameter opportunity, and
evaluation protocol comparable. Explain unavoidable asymmetry.

## 5. Metrics

Every metric needs a name, unit, direction, aggregation, and implementation
reference.

Classification may require class-specific precision and recall, user's and
producer's accuracy, F1, balanced accuracy, calibration, and area-adjusted
estimates. Overall accuracy can hide rare-class failure.

Continuous prediction may require bias, MAE, RMSE, quantile errors, calibration,
coverage, or domain-specific tolerances. Correlation alone does not measure
agreement or bias.

Object detection and segmentation require declared matching, IoU, confidence,
size, and aggregation rules. Scene-, object-, area-, and pixel-level metrics
answer different questions.

Choose the primary metric before testing. Treat additional metrics as
secondary and control multiplicity when they support inferential claims.

## 6. Statistical plan

Specify:

- independent unit and effective sample structure;
- paired or unpaired comparison;
- effect size and its scientific interpretation;
- confidence interval or uncertainty method;
- multiple-comparison procedure;
- spatial and temporal dependence treatment;
- blocking or clustering strategy;
- missing-data handling;
- robustness and sensitivity analyses.

Power or sample-size reasoning should use the independent deployment unit, not
the raw number of pixels or patches. When formal power is infeasible, state the
minimum detectable effect or precision supported by the available independent
units.

## 7. ExperimentSpecCandidate mapping

Populate:

- hypothesisIds with prespecified questions;
- datasetReports only from actual geodata inspection outputs;
- datasetRoles with one scientific role per registered dataset;
- baselines, independentVariables, and controlVariables;
- splitStrategy with units, grouping, buffers, and holdout logic;
- preprocessing with fit population and exact parameters;
- metrics with implementation references and aggregation;
- seeds and ablations;
- statisticalPlan with concrete methods, not placeholders;
- stoppingRule, resourceRequirements, and acceptanceCriteria;
- amendment only when changing a prior frozen protocol, including every
  already observed Run identifier.

## 8. Execution and analysis

Use local registered tests to verify code paths, not to produce final scientific
claims. A formal plan must bind source tree, environment, datasets, seed,
ExperimentSpec, resources, and output envelope.

After execution:

- verify the RunRecord before interpreting output;
- commit ResultRecords only from a succeeded formal Run;
- analyze the primary outcome first;
- report effect size and uncertainty;
- compare against prespecified acceptance criteria;
- disclose failed runs and protocol deviations;
- send the results to independent review before claim approval.

Useful methodological anchors include spatial cross-validation guidance from
Roberts et al. (2017, Ecography, doi:10.1111/ecog.02881) and map-accuracy and
area-estimation good practices from Olofsson et al. (2014, Remote Sensing of
Environment, doi:10.1016/j.rse.2014.02.015).
