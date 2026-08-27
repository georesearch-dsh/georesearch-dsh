# Phase 1 Exit Gate

Status: Phase 1 remains complete and is the required foundation for the Phase
2, Phase 2.5, and Phase 3 runtime.

Historical snapshot recorded on 2026-08-18 (not current acceptance evidence;
rerun the gate below for the current tree):

- 42 test files and 191 tests passed.
- 18 package tarballs passed isolated verification without package-manager
  installation or workspace links.
- 24 packed package and subpath imports, one Web client bundle, and 12 bundled
  schemas passed.
- Final Installer verification passed on installation generation 26 with the
  dump-config check and all four runtime probes current.
- Python hello/deadline/cancel and Windows DPAPI CurrentUser probes passed.

Run the complete Windows gate from the workspace root:

```powershell
pnpm run phase1:gate
```

The command proves these Phase 1 boundaries:

- DeepSeek Harness rc.5 compatibility imports are isolated behind
  `@georesearch/dsh-compat-rc5`.
- The install, upgrade, verify, uninstall, and recover commands pass fault-atomic
  generation tests.
- Home Patch reconciliation performs staged and real Harness mount probes and
  fails closed if telemetry is re-enabled.
- Runtime activation, runtime exclusion, managed-file protection, Preset/Skill
  discovery, Resume identity, role/tool policy, sandbox/spawn, delegation, and
  provider lifecycle tests pass.
- All distribution packages are packed, materialized in an isolated temporary
  project without package-manager installation or workspace links, and
  imported from their tarballs.
- The Python worker validates hello, RFC3339 UTC deadlines, params, cancellation,
  and unbuffered `-u -m georesearch_worker` startup.
- Windows DPAPI CurrentUser protection passes a binding-sensitive round trip.

The DPAPI probe must run under the real current Windows user with that user's
Profile loaded. Impersonated or service contexts without access to the user's
DPAPI master key are expected to fail closed.

The shipped runtime now selects Phase 3, which is a strict capability superset
of the Phase 1 catalog. The Phase 1 runtime probe explicitly accepts both stages:

```yaml
strictCatalog: true
capabilityStage: phase3
```

The Phase 1 gate remains green as part of every later gate. Phase 2, Phase 2.5,
and Phase 3 evidence are recorded in their corresponding gate documents.
