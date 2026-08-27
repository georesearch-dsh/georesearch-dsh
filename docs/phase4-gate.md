# Phase 4 Repository / Reproduction Gate

Status: Phase 4 implementation is complete. The deterministic distribution
gate and the public-repository live activation are separate so network and
external repository availability do not make the offline gate nondeterministic.

Historical snapshot recorded on 2026-08-18 (not current acceptance evidence;
rerun the deterministic and live gates below for the current tree):

- 48 test files and 228 tests passed after rebuilding the 20-package
  distribution.
- All 20 packed tarballs passed clean-room verification with 27 package
  imports and 17 bundle schemas. The verifier used no workspace links, package
  manager install, or external structured-reader dependencies.
- Installer lifecycle coverage passed fault recovery, protected uninstall, and
  a full install from an empty `DSH_HOME`, including real Harness rc.5 boot.
- The verified distribution was transactionally upgraded into the working
  Harness installation as generation 28. A separate installer `verify`
  confirmed the active manifest, dump-config output, and the Phase 1, Phase 2,
  Phase 2.5, and Phase 3 runtime reports against that generation.
- Windows CurrentUser DPAPI passed a real protect/unprotect round trip and
  rejected changed binding entropy. The implementation remains fail-closed
  when invoked from a service, impersonated, or sandbox account without that
  account's loaded user profile.
- The workspace install policy permits the required `esbuild` and `koffi`
  build scripts and explicitly rejects the optional `tesseract.js`
  OpenCollective postinstall. A frozen-lockfile install passes the pnpm
  supply-chain policy without running that optional script.
- The Phase 4 boundary reports three Experiment-only reproduction tools, five
  frozen schemas, the bounded `git-cli` Provider, Host-only report commit, and
  disabled Session Telemetry.
- The Repository Provider uses fixed argv with `shell: false`, strips remote
  credentials before model-visible output, hashes every non-ignored untracked
  file, and performs no repository mutation.
- Dynamic TestSpecs and ReproductionPlan-bound formal runs are re-attested
  against the selected source-tree digest immediately before execution.
- The public live probe audited `google-research/bert` at commit
  `eedf5716ce1268e56f0a50264a88cafad334ac61`, preserved the clean source-tree
  digest, verified that all three selected BERT-Base checkpoint files and a
  TensorFlow 1.x runtime were unavailable, committed a grounded
  `blocked-by-missing-data` report under the root Coordinator, and proved that
  Reviewer could read its JSON Artifact. No repository code was executed.

Run the complete Windows gate from the workspace root:

```powershell
pnpm run phase4:gate
pnpm run probe:phase4-live
```

Run `pnpm run phase4:gate` from the Windows user context that owns the Harness
installation and has its user profile loaded. The gate intentionally exercises
CurrentUser DPAPI and does not substitute a machine-scoped key or a test key.

The first command reruns every earlier foundation, rebuilds the distribution,
verifies packed tarballs without workspace links, performs real Harness boot,
and checks the Phase 4 boundary. The second writes
`dist/reports/phase4-live-activation.json` from a public repository. Together
they prove these Phase 4 boundaries:

- `repository_audit` accepts only the exact Project workspace and a registered
  SourceRecord. It records Git common/worktree identity, HEAD and target commit,
  dirty state, languages, build systems, entry points, configuration, data and
  environment dependencies, tests, blockers, and evidence-grounded method/code
  deltas.
- Git commands are a fixed read-only allowlist executed without a shell,
  prompting, or optional locks. Output, file count, change count, code-file
  bytes, and total hashed bytes are bounded. Embedded remote credentials,
  query strings, and fragments are removed before an URL enters a tool result.
- Source-tree digests bind index identities plus every visible modified,
  deleted, renamed, symlink, and untracked file. The audit re-inspects after
  code-locator hashing and fails if the repository changed during grounding.
- Audit, plan, and TestSpec records are immutable. Repeating the same semantic
  record with a later observation timestamp returns the original record;
  changing content under the same identifier fails closed.
- `reproduction_plan_candidate` binds the registered source, exact repository
  audit, target commit, repository URL, evidence-backed target results, scope,
  environment, materials, steps, outputs, tolerances, and blockers.
- `test_spec_candidate` permits only fixed test-runner families. Dynamic smoke,
  generic shell, command strings, model-supplied Project IDs, and arbitrary cwd
  are unavailable. A local run is rejected when the live workspace no longer
  matches its selected RepositoryAudit.
- A formal run whose ExperimentSpec digest is a ReproductionPlan is checked
  before approval and again before RunRecord commit. Reports accept only runs
  bound to the final audit and the selected TestSpec or ReproductionPlan.
- The Experiment child can create only Audit, Plan, and TestSpec candidates.
  It receives no report commit tool. The root delegation wrapper parses and
  revalidates a strict ReproductionReport Candidate before the Host commits it.
- Reports cannot strengthen the declared reproduction scope, rewrite expected
  metric values or units, claim exact reproduction after source modification,
  or cite unreported runs and non-current Artifacts. Blocked outcomes require
  durable grounding in materials, blockers, runs, or Artifacts.
- Every committed report is also a bounded JSON Artifact whose lineage includes
  the plan, baseline/final audits, reported runs, and diagnostic Artifacts.
  Reviewer receives `artifact_read` and independently reads that report.
- Session Telemetry remains fail-closed disabled. Repository text, code, run
  logs, and tool results are not exported through a telemetry path.

The shipped runtime configuration is:

```yaml
strictCatalog: true
capabilityStage: phase4
```

WAV, MP4, CDF-5, 7Z, and RAR remain intentionally outside the supported
attachment set and fail before Artifact publication.
