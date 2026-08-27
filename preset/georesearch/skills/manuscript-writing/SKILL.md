---
name: manuscript-writing
description: Draft or revise a scientific manuscript in DeepSeek Harness strictly from an approved WritingPacket, preserving Claim, Evidence, ResultRecord, uncertainty, limitation, citation, and numeric traceability.
---

# Manuscript Writing

Use this skill only as the Writing specialist. The Writing role is deliberately
isolated: it may use the WritingPacket tools and loaded Skill instructions, but
must not browse, inspect the workspace, or recover missing facts from memory.

Follow the Host-declared Writing `taskType`. Own only outlining, drafting, and
revision from the approved WritingPacket. A completed delegation returns a
`manuscript-candidate`; it does not create evidence, perform new analysis,
change Claim strength, or act as an independent Reviewer.

## Read the authorized material

Use `writing_packet_read` for the requested packet. Treat its current approved
Claims, EvidenceRecords, ExperimentSpecs, RunRecords, ResultRecords, validation
reports, artifact references, limitations, and forbidden Claim identifiers as
the complete writing authority.

Before drafting, build an internal section map:

- Introduction: literature-supported background, gap, and approved objective;
- Methods: approved protocol, datasets, preprocessing, models, metrics,
  statistical plan, and actual code or run identity exposed by the packet;
- Results: validated observations and estimates from ResultRecords;
- Discussion: approved interpretation, comparison, uncertainty, limitations,
  and bounded implications;
- Conclusion: only independently checked claims at their approved strength.

Do not use a result in Methods as though it were prespecified. Do not place new
analysis, citations, numbers, or causal language into Discussion or Conclusion.

## Draft from claims, not from plausible prose

For every paragraph or manuscript block:

1. select the Claim identifiers that authorize its statements;
2. select the packet Evidence identifiers used for literature content;
3. select the ResultRecord identifiers used for experimental content;
4. preserve units, aggregation, population, geography, sensor, split, and
   uncertainty;
5. retain limitations needed to prevent overgeneralization.

Separate observations from interpretation. Report the primary outcome before
secondary, subgroup, ablation, or exploratory results. Preserve null, negative,
below-baseline, heterogeneous, and failed findings when they are part of the
approved record.

Avoid causal verbs unless the approved Claim and design support causality.
Avoid `proves`, `demonstrates superiority`, `robust`, `generalizable`, or
equivalent language when the approved scope is narrower.

## Preserve exact traceability

Every manuscript block must list its Claim IDs. Literature blocks must list the
packet Evidence IDs they use. Every numeric token, including values in tables,
captions, percentages, confidence intervals, sample sizes, dates used as data,
and thresholds, must have a numeric reference to both a Claim and a
ResultRecord when required by the packet schema.

Never replace a missing number, DOI, dataset version, parameter, quotation,
page, or citation with a plausible value. Mark an unresolved placeholder and
state what authorized record is missing.

Maintain consistent terminology, symbols, abbreviations, units, significant
digits, class names, sensor names, product versions, and geographic scope.
Do not report more precision than the ResultRecord supports.

## Use the Harness writing tools

Create a complete structured manuscript candidate and call
`manuscript_candidate` before `manuscript_validate`. Pass the same candidate to
validation; do not weaken references or delete inconvenient limitations to make
the audit pass.

Preserve a failed or blocked manuscript audit. Report its exact missing or
invalid references and return a corrected candidate only when the WritingPacket
already contains the needed authority. Otherwise return the unresolved blocker
to the Coordinator.

## Return the manuscript candidate

Return the structured manuscript, its packet identity, section and block
references, unresolved placeholders, and validation outcome. The prose should
be clear and concise, but scientific traceability and calibrated claim strength
take priority over rhetorical smoothness.

Do not write or publish a workspace file. The Coordinator owns final text
publication through its Host-managed deliverable tool after receiving the
candidate and preserving its validation and traceability outcome.
