# Provider Extension Guide

Providers are bounded Host adapters. They may access an upstream API, repository,
or scientific runtime, but they do not expose credentials or Host paths to the
model and they never commit authoritative Project records. Services validate a
Provider result, and the root Coordinator performs the final Project commit.

## Common Contract

Every Provider must:

- use `ProviderLifecycle` so new work is rejected after drain begins and cleanup
  runs exactly once;
- publish an immutable, versioned capability record;
- accept `AbortSignal` where work can block and enforce a bounded deadline;
- bound result count, bytes, files, output, and upstream pagination;
- return strict contract types from `@georesearch/dsh-contracts`;
- keep credentials, filesystem paths, subprocess handles, and raw upstream
  responses out of model-visible results;
- make replay behavior explicit and deterministic;
- provide negative, cancellation, drain, and dispose tests;
- remain behind a Service boundary and never register model tools directly.

Use the shared lifecycle around every admitted operation:

```ts
const lifecycle = new ProviderLifecycle()

inspect(request: Request): Promise<Result> {
  return lifecycle.admit(() => inspectBounded(request))
}

drain(): Promise<void> {
  return lifecycle.drain()
}

dispose(): Promise<void> {
  return lifecycle.dispose({ cancel, cleanup })
}
```

## Literature Providers

Implement the public `LiteratureProvider` interface from
`@georesearch/dsh-evidence-providers`:

```ts
interface LiteratureProvider {
  readonly capability: LiteratureProviderCapability
  initialUpstreamState(): JsonValue
  searchPage(request: LiteratureProviderPageRequest): Promise<LiteratureProviderPage>
  drain(): Promise<void>
  dispose(): Promise<void>
}
```

The capability must identify the Provider version, continuation format digest,
replay semantics, maximum page size, and credential support. `upstreamState`
must be serializable Host state. The same request, credential binding epoch, and
state must have explicit replay semantics; do not hide a mutable server cursor
behind a token that appears replay-safe. Credentials arrive through the Host
credential resolver and must never appear in warnings, traces, or items.

Add Provider-specific normalization and warning tests, then rerun the Phase 3,
Phase 6, and Phase 7 gates because Evidence, Claims, and manuscripts consume its
records.

## Repository Providers

`GitRepositoryProvider` is the reference implementation. A replacement must
preserve the `RepositoryInspection` contract and, at minimum:

- canonicalize and confine the repository root;
- resolve the exact target commit and whether it matches `HEAD`;
- record dirty state and bounded changes;
- hash the inspected source tree with explicit file and byte limits;
- detect languages, build systems, entry points, data dependencies,
  environments, and tests without executing repository code;
- reject symlink or path escapes and bound Git output and duration;
- expose only read-only inspection through the Reproduction Service.

Run repository-provider unit tests, Phase 4, and the public Phase 7 case after a
change. Generic Shell, Job, dynamic smoke, and arbitrary repository execution
must remain unavailable to the Experiment role.

## Geospatial Providers

`PythonGeospatialProvider` is the reference external-runtime Provider. It starts
only the fixed `python -u -m georesearch_worker` command through the Harness
subprocess service and negotiates `georesearch-worker/1` over bounded NDJSON.

A compatible Provider must preserve:

- a `ready()` handshake with protocol, worker, Python, method, cancellation,
  deadline, and library capabilities;
- `inspect()` requests containing Host-only verified Artifact paths plus their
  IDs and SHA-256 digests;
- request IDs, deadlines, cancellation, maximum line length, and deterministic
  error codes;
- `drain()` and `dispose()` behavior that cancels, terminates, and joins the
  worker;
- CRS, raster alignment, NoData, categorical resampling, spatial leakage, and
  temporal leakage checks, including mandatory failure behavior.

Do not return dataset paths to the model. New methods require a protocol version
or an explicitly backward-compatible capability addition, contract schemas,
worker and TypeScript tests, and Phase 5 through Phase 7 gate coverage.

## Integration Checklist

1. Add or update the strict contract and JSON Schema first.
2. Implement the Provider in its own package and use `ProviderLifecycle`.
3. Inject it into the owning Service; keep model tools on the Service only.
4. Add the package to `scripts/workspace-packages.ts`, bundle dependencies,
   distribution verification, and Installer import/runtime probes.
5. Add role-catalog and authority-boundary tests.
6. Add deterministic fixtures and a normally disabled real-data probe.
7. Rebuild, pack, run the affected phase gate, and run `phase7:gate` before
   release.
