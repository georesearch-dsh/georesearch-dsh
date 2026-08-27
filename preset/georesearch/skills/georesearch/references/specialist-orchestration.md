# Managed Specialist Orchestration

Use this reference before any GeoResearch delegation. The four managed child
roles are stable ownership boundaries. Task types select a narrower contract
inside a role; supporting Skills add method knowledge without changing
ownership.

## Delegation contract

Every `delegate_*` call must provide:

- `taskType`: one value from the selected role's task catalog;
- `task`: one bounded objective that can produce one decision product;
- `researchQuestion`: the scientific question when it is not already explicit;
- `subjectRefs`: exact digest-bound authoritative records or reports needed by
  the child; at least one is mandatory for every Reviewer task;
- `artifactRefs`: only stable inputs the child actually needs;
- `constraints`: scientific, compute, reporting, or scope limits;
- `additionalSkills`: only role-approved support Skills whose methods are
  materially needed.

The Host derives the core Skills, role charter, completion criteria, and allowed
output kinds. The child receives a task-independent first prompt and must call
`delegation_bootstrap` exactly once to receive those dynamic fields. The Host
then observes successful `skill` calls and blocks every other child tool,
including final structured output, until all required Skills are loaded.

Do not repeat Skill instructions inside `task`. State the scientific objective
and let the child load the authoritative Skill files.

## Role ownership

| Role | Owns | Must not own |
|---|---|---|
| Literature | discovery, screening, source resolution, evidence extraction, claim-centered synthesis, contradictions, gap mapping | frozen protocols, execution, independent review, manuscript drafting |
| Experiment | data fitness, protocol design, reproduction, bounded implementation, registered tests, run preparation | literature coverage claims, independent review, Claim approval, manuscript language |
| Reviewer | read-only evidence, data, protocol, result, reproduction, Claim, and proposal assessment | repairing the subject, approving Claims, writing the manuscript |
| Writing | outline, draft, and revision from an approved WritingPacket | browsing, new evidence, new analysis, changing Claim strength, independent review |

The Coordinator owns decomposition, exact handoff, authoritative commit tools,
stage transitions, and the final user-facing synthesis. It must not present a
specialist candidate as a committed record.

## Task catalog

### Literature

| `taskType` | Core Skills | Expected `outputKind` | Use for |
|---|---|---|---|
| `discovery` | `literature-review` | `literature-search-report` | bounded search, source mapping, field orientation |
| `evidence-extraction` | `literature-review` | `evidence-candidate` | exact proposition and page-grounded evidence |
| `evidence-synthesis` | `literature-review` | `evidence-synthesis` | claim-centered agreement, contradiction, and heterogeneity |
| `citation-verification` | `literature-review` | `citation-audit` | source identity, lineage, and proposition support |
| `research-gap-analysis` | `literature-review`, `remote-sensing-experiment` | `research-gap-map` | converting an evidence map into testable methodological gaps |

Useful optional Skills:

- `geospatial-data` when applicability depends on CRS, scale, resolution,
  labels, spatial support, or leakage;
- `spatial-statistics` when comparing sampling, dependence, validation, map
  accuracy, or inference;
- `remote-sensing-experiment` for method comparison or actionable gap analysis.

Literature work may state experiment-design implications, but the Experiment
role owns the protocol.

### Experiment

| `taskType` | Core Skills | Expected `outputKind` | Use for |
|---|---|---|---|
| `data-assessment` | `geospatial-data` | `data-fitness-report` | whether registered data can answer the question |
| `experiment-design` | `remote-sensing-experiment`, `geospatial-data`, `spatial-statistics` | `experiment-spec-candidate` | hypotheses, estimand, splits, controls, metrics, statistics, ablations |
| `reproduction` | `paper-reproduction` | `reproduction-report` | paper, code, environment, modification, and result reproduction |
| `implementation` | `remote-sensing-experiment`, `geospatial-data` | `implementation-report` | bounded code changes under an existing protocol |
| `run-preparation` | `remote-sensing-experiment`, `geospatial-data` | `formal-run-candidate` | binding source, data, spec, environment, seed, resources, and outputs |

Add `spatial-statistics` to implementation or run preparation when the code
implements spatial blocking, spatial models, resampling, uncertainty, or map
accuracy. Add `paper-reproduction` to implementation only when an existing
paper or repository is the baseline being reproduced.

Local tests verify code paths. They are not formal Runs and cannot support
scientific result claims.

### Reviewer

| `taskType` | Core Skills | Allowed `outputKind` | Review target |
|---|---|---|---|
| `evidence-review` | `scientific-validation`, `literature-review` | `review-assessment`, `review-record` | evidence support and source scope |
| `data-review` | `scientific-validation`, `geospatial-data`, `spatial-statistics` | `review-assessment`, `review-record` | measurement, alignment, dependence, leakage, applicability |
| `protocol-review` | `scientific-validation`, `remote-sensing-experiment`, `spatial-statistics` | `review-assessment`, `review-record` | prespecified design before result interpretation |
| `result-review` | `scientific-validation`, `spatial-statistics` | `review-assessment`, `review-record` | authoritative results, uncertainty, deviations, generalization |
| `reproduction-review` | `scientific-validation`, `paper-reproduction` | `review-assessment`, `review-record` | reproduction lineage and diagnosis |
| `claim-review` | `scientific-validation` | `review-assessment`, `review-record` | Claim type, strength, support, and limits |
| `proposal-review` | `scientific-validation`, `literature-review`, `remote-sensing-experiment`, `spatial-statistics` | `review-assessment`, `review-record` | novelty, prior-art support, falsifiability, identification, feasibility, decisive tests |
| `manuscript-review` | `scientific-validation`, `manuscript-writing` | `review-assessment`, `review-record` | claim fidelity, evidence closure, citation scope, limitations, and manuscript consistency |

Use `review-record` only when the Reviewer actually committed a ReviewRecord.
Use `review-assessment` for an advisory review whose subject is not yet an
authoritative Project record. Both forms require the canonical recommendation
`accept`, `revise`, or `reject`.

The Reviewer receives exact subjects and a neutral question. Do not bias the
task with language such as "confirm that this proposal is excellent".

### Writing

| `taskType` | Core Skill | Expected `outputKind` |
|---|---|---|
| `outline` | `manuscript-writing` | `manuscript-candidate` |
| `section-draft` | `manuscript-writing` | `manuscript-candidate` |
| `full-manuscript` | `manuscript-writing` | `manuscript-candidate` |
| `revision` | `manuscript-writing` | `manuscript-candidate` |

Writing delegation requires an approved WritingPacket. Missing evidence,
numbers, identifiers, or Claims remain explicit blockers; they are not a reason
to send the Writing role to the Web or workspace.

## Multi-stage decomposition

Use separate children when one request contains different ownership decisions.
A frontier-topic request such as "review SWOT applications and propose a major
tsunami or earthquake study" should normally become:

1. Literature `discovery`: map published applications, data products, methods,
   and verified source identities.
2. Literature `evidence-synthesis`: establish what is supported, contested, and
   limited by current observations.
3. Literature `research-gap-analysis`: produce testable gaps rather than a list
   of fashionable topics.
4. Experiment `experiment-design`: turn the selected gap into hypotheses,
   observations, controls, decisive tests, and failure criteria.
5. Reviewer `proposal-review`: independently challenge novelty, identification,
   feasibility, alternatives, and claim strength.
6. Coordinator: reconcile the evidence, design, and review without changing
   their record status or vocabulary.

Do not delegate all six decisions as one literature task. Do not ask the
Reviewer to invent the design it is supposed to assess.

## Handoff and reporting rules

- Pass stable Artifact or record identifiers, not copied source text when a
  Host read tool exists.
- For read-only tasks, pass readable workspace paths in the task and do not
  commit them merely to manufacture delegation references.
- Preserve the candidate exactly when a Coordinator commit tool requires exact
  handoff.
- Treat `needs-user-decision` as a valid bounded result; do not retry it into a
  fabricated completed candidate.
- Treat a failed delegation or Host-rejected candidate as the end of that
  bounded attempt. Do not repeat the same `delegate_*` objective in the current
  user turn merely to repair schema fields, list bounds, or tool errors.
- For a bounded assessment, audit, or readiness decision, report the returned
  blocker and options directly. Do not call `ask_user_question` merely to echo
  them; ask only when continued work requires a material user choice before the
  next authorized action.
- Treat `requiredSkills` and `loadedSkills` returned by delegation as execution
  provenance, not decorative metadata.
- A Provider such as Crossref performs search or metadata resolution; it is not
  a specialist. Say "the Literature specialist used Crossref".
- A candidate is not a Host record. Name `EvidenceRecord`, `ReviewRecord`,
  `ResultRecord`, or `ManuscriptAudit` only when that record exists.
- Preserve formal values such as `accept`, `revise`, `reject`, `passed`,
  `failed`, and `blocked`. Translate them for the user only while retaining the
  canonical value.
