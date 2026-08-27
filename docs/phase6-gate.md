# Phase 6 Gate: Validation, Claim, and Writing

Phase 6 closes the scientific authority chain from immutable inputs to an audited
manuscript.

## Host-owned decisions

- ValidationPlans are generated from the subject domain and frozen Validator
  catalog. A model cannot remove a mandatory Validator.
- Missing, mismatched, blocked, or errored mandatory Validators make the report
  `blocked`; zero executed Validators can never pass.
- Reviewer output is a separate ReviewRecord and never mutates Evidence, Result,
  Run, DatasetManifest, or ExperimentSpec records.
- Claim `supportState`, integrity, validity, and derived calculations are computed
  from current Project state. An approved Claim always requires a user-approval
  outcome from the Harness approval service.
- WritingPacket construction accepts no Claim IDs. It includes the complete set of
  current approved Claims and their exact Evidence/Result/Validation/Run/Spec and
  Artifact closure; all other Claim IDs are forbidden.
- The Writing role has no file, Web, Shell, Job, approval, or child-spawning delegation tools. Its
  only research-data read is `writing_packet_read`.
- Manuscript audit preserves failed outcomes and rejects untraced numbers,
  citations, forbidden Claims, stale packets, and section-policy violations.

## Verification

```powershell
pnpm run phase6:gate
```

The gate checks 3 runtime packages, 9 model-visible tools, 10 strict schemas,
ProjectService second-layer commits, role isolation, and Session Telemetry shutdown.
