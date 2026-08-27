# GeoResearch Lifecycle

Read this reference for multi-stage projects. Use only the stages required by
the user's question; do not force a complete publication workflow onto a
targeted lookup or data inspection.

## 1. Frame the research brief

The brief should make the scientific decision space explicit:

- problem and motivation;
- research question;
- target population, geography, time, sensor, and spatial support;
- descriptive, predictive, inferential, causal, or reproducibility objective;
- hypotheses or decision criteria;
- primary outcome and important secondary outcomes;
- available data and known constraints;
- intended deliverables;
- ethical, legal, licensing, safety, and compute constraints;
- material choices that require user confirmation.

Commit a ResearchBrief only after material choices are settled. Do not treat a
temporary working assumption as user-confirmed scope.

## 2. Establish the evidence basis

Use literature work to determine:

- accepted definitions and methods;
- relevant baselines and expected ranges;
- known confounders, failure modes, and limitations;
- contested findings and unresolved gaps;
- reporting standards that apply to the study type.

The literature stage should change the experiment design. If it merely produces
a bibliography, it has not yet established a useful evidence basis.

## 3. Establish data fitness

For every intended dataset, confirm:

- identity, source, version, lineage, and license;
- coverage relative to the research population;
- measurement process and reference quality;
- CRS, units, resolution, support, and temporal alignment;
- missingness, masks, invalid values, and known biases;
- independence structure and leakage risks;
- whether the available data can identify the intended estimand or test the
  claimed generalization.

Data can be technically readable but scientifically unfit.

## 4. Freeze the protocol

A defensible protocol states in advance:

- hypotheses and primary outcome;
- dataset roles and immutable testing units;
- preprocessing and feature construction;
- baselines and controls;
- model or analytical method;
- metrics, aggregation, and implementation references;
- statistical analysis, effect sizes, uncertainty, multiplicity, and spatial
  dependence handling;
- seeds, ablations, stopping rules, resources, and acceptance criteria;
- expected artifacts and failure diagnostics.

Exploratory work may remain flexible, but it must be labeled exploratory.
Confirmatory claims require a protocol that predates testing-result inspection.

## 5. Execute through Harness authority

The DeepSeek Harness roles separate reasoning from authority:

| Actor | Primary responsibility | Authoritative mutations |
|---|---|---|
| Coordinator | Scope, delegation, exact candidate handoff, project progression, final text publication | Host-owned commit, formal-run, and deliverable tools |
| Literature specialist | Search, resolve, read, extract, synthesize | Evidence candidate; Host wrapper commits eligible evidence |
| Experiment specialist | Inspect, design, edit bounded workspace code, propose runs | Candidate tools and registered local tests |
| Reviewer | Recompute Host checks and independently interpret | Immutable validation and review records |
| Writing specialist | Draft from the isolated WritingPacket | Manuscript candidate and deterministic audit |

Never ask a specialist to use a tool outside its current role catalog. Never
copy a specialist candidate into a new hand-authored object when an exact
Coordinator handoff is required.

## 6. Analyze results

Analysis should answer the prespecified question before exploring secondary
patterns:

- verify run, source, dataset, and ExperimentSpec identity;
- report the primary outcome with effect size and uncertainty;
- compare against the correct baseline and acceptance criterion;
- inspect assumption violations, missing data, sensitivity, and heterogeneity;
- distinguish failed execution from a valid negative scientific result;
- separate confirmatory, secondary, ablation, subgroup, and exploratory results;
- state what population, geography, time, and sensor are actually supported.

## 7. Validate and approve claims

Host validation establishes mandatory lineage and deterministic checks.
Independent review establishes scientific interpretation and limitations.
Neither alone authorizes manuscript language.

A Claim should state one proposition at an appropriate strength and include:

- exact EvidenceRecord or ResultRecord support;
- calculation details when derived;
- required validation and review identifiers;
- limitations necessary to prevent overgeneralization;
- intended manuscript sections.

Do not approve a claim whose support is stale, insufficient, failed, or outside
the tested scope.

## 8. Write and preserve uncertainty

Build the WritingPacket only after claims are current and approved. Draft
Methods from the frozen protocol and actual execution identity, Results from
validated records, and Discussion from approved interpretation. Preserve
negative results, limitations, uncertainty, and unresolved blockers.

The Writing specialist returns a candidate. The Coordinator publishes an
approved or explicitly requested final text only through the Host-managed
deliverable tool, under `deliverables/`, with relevant input digests preserved.

## Stage transition rule

Advance when the next stage has the minimum authoritative inputs it needs.
Otherwise return the missing input and the bounded action needed to obtain it.
Do not advance merely because the user asked for the final deliverable.
