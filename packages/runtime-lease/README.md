# @georesearch/dsh-runtime-lease

Holds a process-scoped lease while a normal GeoResearch Profile is active.
Installer mutations acquire the same lease before creating a transaction, so an
active runtime is rejected without publishing a partial generation. A validated
maintenance probe skips the runtime lease because its parent installer already
owns it and the installation guard has consumed the bound nonce.

Windows uses a named mutex. Other platforms use a local Unix socket whose
kernel-owned listener disappears when the process exits; stale socket paths are
removed only after a failed connection probe.
