# Phase 2 Exit Gate

Status: Phase 2 Project Core and run foundation remain complete under the
strict Phase 3 runtime.

Historical snapshot recorded on 2026-08-18 (not current acceptance evidence;
rerun the gate below for the current tree):

- 42 test files and 191 tests passed.
- The real Installer lifecycle passed all three install/recovery/uninstall
  scenarios, including an empty `DSH_HOME`.
- 18 package tarballs passed isolated verification without package-manager
  installation or workspace links; 24 packed package and subpath imports, one
  Web client bundle, and 12 bundled schemas passed.
- The Phase 1, Phase 2, Phase 2.5, and Phase 3 runtime probes completed for
  installation generation 26 in the same bounded Harness boot with Session
  Telemetry absent; final Installer dump-config and runtime-probe verification
  passed.
- Python hello/deadline/cancel and Windows DPAPI CurrentUser probes passed.

Run the complete Windows gate from the workspace root:

```powershell
pnpm run phase2:gate
```

The command first reruns the complete Phase 1 gate, then verifies the Phase 2
foundation within the current Phase 3 composition. It proves these boundaries:

- Workspace identity is derived from the exact live Agent Session `cwd`;
  attach, rebind confirmation, clone separation, and worktree sharing are
  covered.
- Project state uses a Windows named mutex, append-only events, deterministic
  reduction, generation checks, operation keys, request digests, exact replay,
  conflict rejection, and Recovery Scan.
- Artifact publication uses a same-handle snapshot, content-addressed storage,
  lineage metadata, no-clobber publication, integrity revalidation, and stale
  propagation.
- Final text publication is confined to `deliverables/`, remains separate from
  generic workspace mutation, requires digest-bound replacement, rejects path
  indirection, and can recover a materialized file whose Project event was
  interrupted.
- `ResearchBrief`, `ProjectSnapshot`, and `RunRecord` have strict runtime
  parsers and matching standalone JSON Schema assets.
- Tool schemas are projected through the rc.5 Compatibility Adapter without
  weakening the authoritative persisted schemas or runtime parsers.
- `local_test_run` accepts only a Host-registered `testSpecId`; shell launchers,
  `python -c`, redirection, and unregistered executables fail closed.
- Formal runs bind exact argv and digest, Workspace identity, input digests,
  resource limits, sandbox enforcement, and a user approval audit.
- The only process path is policy authorization, `ctx.sandbox.confine()`, exact
  confined argv, `ctx.subprocess.spawn()`, collection, and terminate-and-join.
- The Host-owned Run Supervisor persists intent before spawn, records PID and
  process creation time, retains stdout/stderr and strict exit markers, and
  rejects PID reuse without binding formal runs to Agent or Tool lifetime.
  Terminal markers reconcile after restart. A live process whose Harness
  collector was lost across Host restart is terminated and marked
  `recovery-required`; collector reattachment is not claimed.
- Installer activation checks the strict Phase 2 foundation, Project and Run
  services, all eleven Phase 2 tools, frozen schemas, required execution services,
  and telemetry absence.

The shipped runtime configuration is:

```yaml
strictCatalog: true
capabilityStage: phase3
```

Phase 3 is now active as a strict capability superset. Its additional Provider,
Continuation, PDF evidence, Source, and Evidence guarantees are recorded in
`docs/phase3-gate.md`.
