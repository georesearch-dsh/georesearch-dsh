# Evidence Synthesis for Geospatial Research

Use this reference for broad, systematic-style, scoping, or contradiction-aware
reviews. It is a decision guide, not a claim that the available provider set is
comprehensive.

## Match the review form to the question

| Review form | Appropriate use | Required caution |
|---|---|---|
| Targeted lookup | One fact, method, dataset, or citation | Do not generalize beyond the located source |
| Narrative review | Conceptual orientation or field overview | Make selection subjectivity explicit |
| Scoping review | Map methods, datasets, concepts, and gaps | Usually characterizes evidence rather than estimating one effect |
| Rapid review | Time-bounded decision support | Record every shortcut and its likely bias |
| Systematic-style review | Reproducible search and eligibility process | Requires broader source coverage than one provider may supply |

## Structure the question

Adapt the following fields rather than forcing a clinical template:

- population, place, ecosystem, object, or phenomenon;
- exposure, intervention, sensor, algorithm, or analytical method;
- comparator, baseline, reference product, or alternative method;
- outcome, metric, effect, accuracy, uncertainty, or decision;
- geography, scale, period, study design, and deployment setting.

Define which differences would make a study inapplicable: sensor family,
processing level, spatial resolution, target class, climate or biome, label
source, validation unit, or prediction horizon.

## Build the search

Create concept groups with synonyms, acronyms, product names, and spelling
variants. Combine synonyms within a concept and then combine concepts. Record
the exact query sent to each provider.

Use date and publication-type filters only when scientifically justified. A
date limit may exclude foundational methods; a journal-only filter may exclude
important datasets, standards, software papers, and current preprints.

The current fixed literature provider may not cover every relevant database.
State this limitation and use visible complementary discovery tools only when
they add a distinct source class. Do not describe the result as exhaustive
unless the actual search supports that statement.

## Screen consistently

Apply eligibility in order:

1. bibliographic identity and duplicate handling;
2. title and abstract relevance;
3. full-text eligibility;
4. availability of extractable evidence for the target question.

Record one principal exclusion reason at the stage where exclusion occurs.
Keep borderline studies visible until the unresolved criterion can be decided.

## Extract comparable fields

For each included study, extract:

- stable identifier and full citation;
- study objective and design;
- geography, dates, population, sampling frame, and sample size;
- sensor, platform, product, processing level, resolution, and bands;
- label or reference-data construction;
- preprocessing, split strategy, model, baseline, and hyperparameter selection;
- primary and secondary metrics, aggregation units, effect estimates, and
  uncertainty;
- spatial and temporal independence controls;
- missing-data handling, exclusions, and sensitivity analyses;
- authors' limitations and limitations visible from the design;
- exact page, section, table, or figure supporting each evidence statement.

Do not convert incompatible metrics or populations into a common comparison
without an explicit, valid transformation.

## Judge relevance and credibility

Evaluate at least:

- directness to the target question and geography;
- measurement validity and reference-data quality;
- sampling and split design;
- risk of spatial or temporal leakage;
- baseline fairness and metric appropriateness;
- uncertainty and multiple-comparison handling;
- reproducibility of data, code, and configuration;
- selective reporting or unexplained attrition;
- independence from other included publications using the same data or study.

Do not reduce credibility to a single numeric score unless a recognized tool is
required and its interpretation is preserved.

## Synthesize by claim

Create a claim-centered evidence table:

| Claim or question | Supporting studies | Contradicting studies | Design differences | Supported scope | Residual uncertainty |
|---|---|---|---|---|---|

Explain heterogeneity before calculating or implying an average. Important
sources include geography, sensor, resolution, target definition, reference
quality, sampling, validation strategy, metric implementation, model capacity,
and time period.

When quantitative synthesis is appropriate, define the effect measure,
independence unit, variance source, model, heterogeneity measure, weighting,
and sensitivity analyses before pooling. Do not pool accuracy values that refer
to incompatible tasks or validation designs.

## Report limits

Report:

- providers and dates searched;
- exact concepts, filters, and stopping rule;
- screening and eligibility decisions;
- unavailable full text or missing study details;
- source coverage limitations;
- risk of bias and applicability concerns;
- contradictions and unresolved questions;
- whether the synthesis is qualitative, quantitative, or only a map of evidence.

Useful external standards include PRISMA 2020 for systematic review reporting
and ROSES for systematic evidence syntheses in environmental research. Apply
them only to the extent supported by the actual workflow.
