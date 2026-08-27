# Spatial Statistical Methods

Use this reference to choose a defensible spatial design, diagnostic, model, or
validation strategy. Method selection begins with the scientific target and
sampling process, not with a preferred software package.

## 1. Identify the target

| Objective | Central question | Typical evidence |
|---|---|---|
| Description | Where and how does a variable vary? | Maps, summaries, uncertainty, scale |
| Pattern detection | Is the observed spatial pattern inconsistent with a stated null? | Global or local statistic with valid randomization |
| Finite-population estimation | What total, mean, area, or accuracy applies to a defined region? | Probability sample and design-based estimator |
| Association | How does an outcome vary with covariates after accounting for dependence? | Model, residual diagnostics, effect estimates |
| Prediction | How well will predictions transfer to the deployment distribution? | Spatially representative held-out evaluation |
| Causal inference | What would change under an intervention or exposure contrast? | Identification design plus spatial confounding analysis |
| Spatiotemporal analysis | How do level, trend, or change vary over space and time? | Joint space-time design and validation |

Do not use cluster detection to answer a causal question or random
cross-validation to answer regional transfer.

## 2. Define units and spatial support

Record:

- observational and independent units;
- point, line, polygon, raster-cell, object, plot, scene, or regional support;
- target spatial and temporal population;
- sampling frame and inclusion mechanism;
- coordinate reference system and distance units;
- spatial resolution and aggregation;
- repeated observations and shared acquisition sources.

Check for ecological and atomistic fallacies and for sensitivity to the
modifiable areal unit problem. Relationships at one zoning or resolution may
not hold at another.

## 3. Construct spatial relationships

Choose spatial weights or neighborhoods using the process and design:

- rook or queen contiguity for meaningful polygon adjacency;
- k-nearest neighbors when each unit needs a comparable neighbor count;
- distance bands when a scientific interaction range exists;
- kernels when influence is expected to decay smoothly;
- network distance for movement constrained to networks;
- hierarchical or graph relationships for nested or connected systems.

Record symmetry, row standardization, islands, disconnected components,
self-neighbors, distance metric, threshold, and sensitivity choices.

Do not optimize the weights definition against the desired p-value. If several
definitions are scientifically plausible, predeclare a primary definition and
use the others as sensitivity analyses.

## 4. Global and local diagnostics

Moran's I assesses global spatial autocorrelation relative to the stated
weights and null. Geary's C emphasizes local pairwise differences. Variograms
or correlograms help characterize dependence over distance for continuous
processes.

For each diagnostic, report:

- variable or residual being tested;
- transformation and weights;
- null and permutation or asymptotic procedure;
- statistic, expected value, uncertainty, and p-value when used;
- sensitivity to weights, scale, and influential units.

Always inspect model residuals. A spatially structured outcome can be modeled
adequately, while spatially structured residuals indicate remaining
misspecification.

Local indicators such as local Moran statistics or Getis-Ord statistics create
many local tests. Control or clearly qualify multiplicity and avoid treating a
cluster map as a stable physical boundary without sensitivity analysis.

## 5. Sampling and validation

### Probability sampling

For finite-region estimates, preserve inclusion probabilities, strata,
clusters, and unequal weights. Use the sampling design in the estimator and
variance calculation. A spatially balanced probability design can improve
coverage but does not eliminate the need to report the design.

### Predictive validation

Match resampling to deployment:

- GroupKFold-like grouping for shared scenes, plots, objects, or acquisition
  units;
- spatial blocks for transfer beyond local dependence;
- buffered leave-location-out for nearby training exclusion;
- leave-region-out for external geographic transfer;
- temporal holdout for future prediction;
- nested spatial resampling when hyperparameters are selected;
- sensor- or domain-held-out validation for domain transfer.

The inner selection loop must respect the same leakage source as the outer
evaluation. Standard random inner validation can leak even when the outer split
is spatial.

Choose block or buffer size using a combination of empirical dependence range,
sampling density, deployment distance, ecological scale, and available
independent units. Report sensitivity rather than claiming one universal block
size.

## 6. Model families

Choose the simplest model that represents the target and dependence.

### Spatial regression

- Spatial lag or SAR models represent dependence transmitted through the
  response structure.
- Spatial error or SEM models represent spatially correlated unexplained
  variation.
- Conditional or simultaneous autoregressive models can represent areal random
  effects.
- Spatial random effects or Gaussian processes model covariance over space.
- Multilevel models handle nested regions or clusters when that hierarchy is
  scientifically meaningful.

Check identifiability, weights, residual dependence, coefficient
interpretation, and whether the model changes the estimand.

### Local models

Geographically weighted regression and similar local models may reveal spatial
heterogeneity but are sensitive to bandwidth, collinearity, edge effects, and
multiple local estimates. Treat them as exploratory unless the design and
validation support stronger inference.

### Machine learning

Flexible predictors do not remove spatial dependence. Use deployment-matched
validation, inspect residual spatial structure, assess calibration and
uncertainty, and compare against spatially informed as well as simple
baselines.

### Spatiotemporal models

Separate spatial, temporal, and interaction structure. Prevent future
information, overlapping windows, and repeated-unit leakage. Report whether the
claim concerns forecasting, interpolation, trend, or change.

## 7. Inference and uncertainty

The resampling or variance unit must match the independent unit. Consider:

- cluster-robust or spatial covariance estimates;
- block or spatial bootstrap;
- permutation tests with exchanges valid under the null;
- model-based covariance from a justified spatial model;
- Bayesian posterior uncertainty with explicit prior and model checks;
- design-based variance for probability samples.

Avoid naive observation-level bootstrap for strongly dependent pixels or
patches.

Report effect sizes in scientific units with confidence or credible intervals.
For equivalence or non-inferiority, declare the margin before analysis.

Control multiplicity across metrics, classes, regions, time periods, local
statistics, and model comparisons when they support inferential claims.
Preserve exploratory status when a valid family cannot be defined after the
fact.

## 8. Map accuracy and area estimation

For categorical maps:

- define the target map and class legend;
- document probability-sampling and response designs;
- maintain independence between training labels and reference observations;
- estimate the error matrix under the sampling design;
- report user's and producer's accuracy and uncertainty;
- estimate class area and uncertainty with design-appropriate adjustment;
- disclose ambiguous or mixed reference units.

For continuous maps:

- report bias, MAE or RMSE at the intended unit;
- inspect error quantiles, heteroscedasticity, calibration, and residual maps;
- validate spatial transfer;
- propagate reference measurement uncertainty when material;
- distinguish pixel-level error from regional aggregate error.

Olofsson et al. (2014, doi:10.1016/j.rse.2014.02.015) is a key reference for
good practices in land-change map accuracy and area estimation.

## 9. Software selection in DeepSeek Harness

Use software only when it is present or can be declared in the bound execution
environment. Candidate ecosystems include:

- Python: GeoPandas, Rasterio, Xarray, PySAL esda and spreg, scikit-learn
  grouped resampling, statsmodels, and domain-specific spatial-CV packages;
- R: sf, terra, spdep, spatialreg, blockCV, gstat, mgcv, INLA, or comparable
  maintained packages.

Do not assume a library is installed. Inspect environment declarations, write
bounded analysis code in the experiment workspace, verify it through supported
registered tests, and execute scientific analysis through a formal Run plan.
Record package versions and method parameters.

The GeoResearch geodata inspection tool validates declared metadata and
controls; it does not by itself prove that an autocorrelation statistic or
spatial model was computed.

## 10. Reporting checklist

Report:

- target population, estimand or prediction target;
- spatial and temporal units and support;
- sampling and missing-coverage mechanisms;
- CRS and distance units;
- weights, neighborhoods, blocks, or buffers;
- dependence diagnostics and residual results;
- model, resampling, and hyperparameter-selection design;
- effect size, uncertainty, and multiplicity;
- sensitivity to weights, scale, blocks, and influential regions;
- geographic, temporal, sensor, and resolution limits;
- software, versions, seeds, and committed artifacts.

Foundational references include Moran (1950, Biometrika,
doi:10.1093/biomet/37.1-2.17), Anselin (1995, Geographical Analysis,
doi:10.1111/j.1538-4632.1995.tb00338.x), and Roberts et al. (2017, Ecography,
doi:10.1111/ecog.02881).
