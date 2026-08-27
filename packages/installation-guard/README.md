# @georesearch/dsh-installation-guard

Provides `ctx.geoResearchInstallation` only after the managed generation and all
recorded digests validate. A polling monitor disposes the provider fiber when
installation drift or Session Telemetry appears, which unloads injected
GeoResearch consumers.

Validation covers the managed installation carrier, the shared runtime package
tree, and the GeoResearch-owned dependency and bundle fields in every integrated
Web Profile. Unrelated user fields and dependencies remain outside the managed
digest surface.

The Profile `cordis.yml` root is a Harness-owned runtime anchor and is excluded
from new managed tree digests. Legacy installation manifests that explicitly
recorded the file continue to use the legacy digest policy.

The maintenance nonce is single-use and 256-bit. Disk stores only its SHA-256
digest; the child environment receives a Windows DPAPI CurrentUser-protected
blob whose optional entropy binds transaction, generation, executable, and
deadline. Tests may use AES-256-GCM only when `NODE_ENV=test` and an explicit
32-byte `GEORESEARCH_TEST_NONCE_KEY` is supplied.
