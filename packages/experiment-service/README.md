# `@georesearch/dsh-experiment-service`

Phase 5 protocol-lock and result service. Experiment children can validate only
an `ExperimentSpecCandidate`. The root Coordinator atomically commits the
revalidated geodata reports, DatasetManifests, frozen ExperimentSpec, and an
optional immutable Amendment. `result_commit` accepts no metric values; it
extracts exactly one `GEORESEARCH_RESULT_V1` envelope from a succeeded formal
Run log and commits every ResultRecord from that envelope together.
