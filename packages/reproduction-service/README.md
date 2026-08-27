# `@georesearch/dsh-reproduction-service`

Phase 4 Host service for repository audits, grounded method/code deltas,
ReproductionPlan candidates, Project-bound TestSpecs and immutable
ReproductionReports.

The Experiment role can inspect and create candidates but receives no generic
shell or formal-run submit capability. A report is committed only after the
delegation Host wrapper revalidates it under the root Coordinator identity.
Expected metric values and units remain locked to the plan, blocked outcomes
must cite durable grounding, and diagnostic Artifact digests participate in
the report Artifact lineage.
