# Scientific Result Interpretation

Use this reference after deterministic Host validation to review scientific
meaning that lineage checks alone cannot establish.

## Start from the claim type

Classify the intended claim:

- descriptive: what was observed in the analyzed data;
- associative: variables covary under the study design;
- predictive: performance on a declared target distribution;
- causal: an intervention or exposure changes an outcome under stated
  identification assumptions;
- mechanistic: a process explanation supported by specific evidence;
- reproducibility: a prior computational result was obtained under declared
  conditions.

The design determines the strongest allowable type. Model complexity, low
p-values, or high accuracy cannot upgrade an associative design to causality.

## Verify the analysis population

Compare the intended population with the actual analyzed records:

- exclusions and missingness;
- geography, dates, sensors, classes, and operating conditions;
- final sample and independent-unit counts;
- split membership and repeated observations;
- whether failed preprocessing or missing coverage changed the target.

Report attrition and selection mechanisms. A result may be internally correct
for a narrower population than the manuscript claims.

## Primary outcome and multiplicity

Identify the prespecified primary outcome and comparison. Treat additional
metrics, regions, classes, time periods, models, seeds, and hyperparameter
searches as multiplicity sources.

Check whether the reported inference matches the actual family of comparisons.
When no correction was planned, present secondary findings as exploratory
unless the design supplies another valid justification.

Do not infer that an unreported comparison was unfavorable, but identify
selective-reporting risk when the complete result set is unavailable.

## Effect size and uncertainty

Review:

- the effect measure and its scientific unit;
- paired versus unpaired structure;
- confidence or credible interval construction;
- cluster, spatial, temporal, or repeated-measure dependence;
- bootstrap or permutation resampling unit;
- practical threshold or minimum meaningful effect;
- whether uncertainty includes data, sampling, model, and measurement sources
  relevant to the claim.

A narrow interval from millions of correlated pixels may be less informative
than a wider interval based on a small number of independent scenes or regions.

Statistical significance does not imply practical importance. Absence of
statistical significance does not establish equivalence without an equivalence
design and margin.

## Predictive performance

Check:

- whether the test distribution represents deployment;
- whether model selection used testing information;
- baseline fairness and compute or data parity;
- class-specific and subgroup performance;
- calibration and threshold selection;
- uncertainty across independent units and seeds;
- failure cases, coverage, abstention, and operational costs;
- sensitivity to region, season, sensor, resolution, and preprocessing.

One aggregate metric cannot establish universal superiority.

## Remote-sensing accuracy

For classification, inspect the response design and sampling design as well as
the confusion matrix. Report user's and producer's accuracy, class prevalence,
uncertainty, and area-adjusted estimates when appropriate. Pixel accuracy from
a convenience sample does not necessarily estimate map accuracy or area.

For continuous products, examine bias, error distribution, calibration,
heteroscedasticity, residual spatial structure, and error at the intended
aggregation unit. Correlation is not agreement.

For detection or segmentation, verify matching rules, confidence thresholds,
object size, boundary tolerance, and aggregation.

## Robustness and sensitivity

Look for conclusions that change under reasonable choices of:

- split or spatial block;
- seed or initialization;
- label quality threshold;
- preprocessing and mask;
- metric implementation;
- baseline configuration;
- inclusion criteria;
- spatial or temporal resolution;
- model specification;
- influential region, scene, or cluster.

Robustness means stability across prespecified or scientifically defensible
perturbations, not a collection of favorable variants.

## Internal and external validity

Internal validity threats include leakage, confounding, label construction from
predictors, post-treatment adjustment, protocol deviations, uncontrolled
preprocessing, and selective reporting.

External validity threats include restricted geography, one sensor or season,
coverage bias, domain shift, unsupported scale changes, and dependence between
test and training environments.

State the exact supported scope and the evidence needed to broaden it.

## Finding construction

Each review finding should include:

- severity;
- subject identifier;
- observed record or artifact;
- scientific assumption or reporting requirement;
- why the evidence satisfies or violates it;
- consequence for the claim;
- bounded correction or additional evidence;
- whether the issue is confirmed or unresolved.

Use blocking severity when the central claim cannot be evaluated, lineage is
invalid, testing was contaminated, or a required assumption is contradicted.
Use major severity when the conclusion materially exceeds the evidence.
