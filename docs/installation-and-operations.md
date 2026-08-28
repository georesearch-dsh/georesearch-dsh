# Installation and Operations

GeoResearch is installed as an out-of-tree managed distribution. The installer
does not modify the DeepSeek Harness source tree, does not use `postinstall`, and
publishes `active.json` only after the candidate generation and every integrated
Web Profile pass configuration, import, runtime, Preset, and telemetry probes.

## Prerequisites

- Windows 10 or Windows 11 x64.
- DeepSeek Harness `0.1.0-rc.5` installed under the target `DSH_HOME`.
- Node.js `^22.19.0` or `>=24.0.0`.
- Python 3.10 or newer for geospatial workflows; `rasterio` and `pyproj` are
  required for raster inspection and the public release probe.
- Git on `PATH` for repository audit and reproduction workflows.
- A managed `DEEPSEEK_API_KEY` credential for automatic
  `deepseek-v4-flash-vision-exp` analysis. Without it, image reads remain
  available through explicit native-model/local-OCR fallback warnings.
- Close running Harness processes before install, upgrade, recovery, or
  uninstall so the Windows directory publication preflight can obtain delete
  access to managed directories.

The default home is `%USERPROFILE%\.dsh`. Set `DSH_HOME` or pass
`--dsh-home <path>` to select another installation.

## Published Package

Use an exact installer version. Do not use an unpinned `latest` tag for release
operations.

```powershell
npx --yes @georesearch/dsh-installer@0.1.0 install --dsh-home $env:DSH_HOME
npx --yes @georesearch/dsh-installer@0.1.0 verify --dsh-home $env:DSH_HOME
```

The self-contained installer tarball carries `distribution.tar`; no checkout,
workspace link, or separate `--distribution-dir` is required.

## Local Release Candidate

```powershell
pnpm run release:gate
node packages/installer/lib/cli.js install `
  --dsh-home D:\path\to\.dsh `
  --distribution-dir dist\distribution `
  --harness-root D:\path\to\deepseek-harness
```

Run `release:gate` from a clean Git worktree in the interactive Windows user
context that owns `DSH_HOME`. It pins pnpm, verifies the frozen dependency tree,
audits production dependencies, runs the deterministic and public Phase 7
checks, validates all package manifests and tarballs with publint and
`npm publish --dry-run`, and writes `dist\release\release-manifest.json` plus
`dist\release\SHA256SUMS`. The command never publishes a package.

After installation, start an existing Web Profile or the managed diagnostic
Profile:

```powershell
dsh --profile web
dsh --profile georesearch
```

The same credential configured for the Harness `deepseek-official` route is
resolved per visual-analysis request; GeoResearch does not maintain a second
secret store. See `deepseek-vision.md` for the provider and fallback boundary.

The installer appends `@georesearch/dsh-bundle` after the base and Web bundles
in every Profile containing `@deepseek-ai/dsh-web-app`. It does not write a
global `agent-presets.default` setting.

That bundle bootstraps the pinned DSH product adapter and the adapter discovers
`@georesearch/dsh-bundle/dsh-plugin.json` from the Profile dependency list.
Activation must publish the `org.deepseek.georesearch` Host facet before the
Phase 1 installation probe can commit a generation. No separate npm install of
`@dsh-std/*` packages is performed on the target machine; the adapter runtime is
embedded in the signed distribution package.

## Verify and Reconcile

Run verification after installation, after a Harness repair, and before an
upgrade:

```powershell
npx --yes @georesearch/dsh-installer@0.1.0 verify --dsh-home $env:DSH_HOME
```

Verification is read-only unless `--reconcile-home-patch` is supplied. Use the
reconcile form only when verification reports that the managed Home patch has
drifted and the current user-owned Profile state should be preserved in a new
installation generation:

```powershell
npx --yes @georesearch/dsh-installer@0.1.0 verify `
  --dsh-home $env:DSH_HOME `
  --reconcile-home-patch
```

The command refuses to reconcile a configuration that re-enables Session
Telemetry.

## Upgrade

Upgrade with the exact target version:

```powershell
npx --yes @georesearch/dsh-installer@0.1.0 upgrade --dsh-home $env:DSH_HOME
npx --yes @georesearch/dsh-installer@0.1.0 verify --dsh-home $env:DSH_HOME
```

The upgrade snapshots every managed path, stages the new generation, probes it,
and commits the activation marker last. A failure before that marker retains the
previous generation or leaves a fail-closed transaction for recovery.

### Prompt-cache compatibility

DeepSeek prompt caching is exact-prefix based. A GeoResearch upgrade may change
the static system prompt or the model-visible tool catalog, which creates a new
request-header cache epoch. Resuming a long session from an older epoch can then
make the first request reprocess the complete durable history before subsequent
requests return to the normal warm-cache rate.

- Start a new GeoResearch task after every plugin upgrade or managed Profile
  digest change. Keep the old task for audit and reference, not as the first
  post-upgrade model request.
- Do not use the task-wide cache percentage to evaluate a new build when the
  task spans upgrades. The UI aggregates the whole durable log, so historical
  misses remain in the displayed percentage.
- For a same-build check, compare requests after the first cold request. The
  static prompt and tool catalog must remain byte-identical across restarts;
  dynamic capability changes belong in `georesearch:runtime` or Skills.
- Compare each routed model separately. DeepSeek prompt caches are model-bound,
  so Pro, Flash, and Flash Vision do not warm one another. Short one-shot Flash
  children should be evaluated by first-call stable-prefix reuse, not against a
  long Pro session with many warm continuation calls. For a given role/model,
  the first child may be cold; later children with different task types should
  hit the fixed task-independent `delegation_bootstrap` request.
- Verify the child's recorded source model as well as the parent's selected
  model. Managed delegation inherits the latest persisted request route; a
  Flash parent must create Flash children even when the Agent was originally
  created under a Pro deployment default.
- A low provider cache percentage for unique vision inputs is expected because
  the image tokens differ. Use `cache-status="local-exact-hit"` to verify that
  repeated identical image requests avoided the provider entirely. Concurrent
  identical reads are coalesced while the first provider request is in flight.
- Treat edits to the static integrity section or Coordinator tool parameters as
  cache-ABI changes. Keep those surfaces compact and stable, and retain strict
  validation in Host services rather than duplicating evolving specialist
  schemas into every Coordinator request.
- Keep specialist task data out of the first child request. Dynamic task type,
  required Skills, authority, question, constraints, and task text must remain
  in the one-use `delegation_bootstrap` payload so DeepSeek can persist and
  reuse one complete first-request cache unit per role/model.

From a development checkout, inspect one session file or the complete sessions
directory without printing prompt or message content:

```powershell
pnpm run cache:analyze -- D:\path\to\.dsh\sessions --json
```

Use `sameEpochHitPct` for steady-state behavior and
`resetMissSharePct` to quantify misses attributable to cold or changed request
headers.

## Recover

Use recovery after an interrupted install, upgrade, reconcile, or uninstall:

```powershell
npx --yes @georesearch/dsh-installer@0.1.0 recover --dsh-home $env:DSH_HOME
npx --yes @georesearch/dsh-installer@0.1.0 verify --dsh-home $env:DSH_HOME
```

Recovery validates transaction identity and either rolls back the incomplete
generation or completes a generation whose activation commit was durable. Do
not manually delete transaction journals or backups before recovery succeeds.

## Uninstall

```powershell
npx --yes @georesearch/dsh-installer@0.1.0 uninstall --dsh-home $env:DSH_HOME
```

Uninstall removes only GeoResearch-owned package, Preset, Profile, and bundle
entries. It preserves later user changes and refuses to delete modified managed
Skills unless the protected lifecycle can recover or report the conflict.

## Failure Diagnosis

1. Stop all Harness processes and rerun the command if Windows reports a managed
   directory access conflict.
2. Run `recover` when a transaction is pending.
3. Run `verify` and retain its JSON output together with the transaction journal
   when escalation is required.
4. Never repair a failed installation by copying package directories manually;
   that bypasses generation digests, the runtime guard, and recovery identity.
