# @georesearch/dsh-run-supervisor

The Phase 2 Supervisor persists launch intent before process creation, records
PID and process creation time in a launch receipt, captures stdout/stderr to
Host-private run paths, and writes an exit marker before the Run Service forms
a terminal RunRecord.

It owns no Agent or Tool reference. A new service instance can validate a
persisted terminal marker from launch ID, PID, and creation time. It cannot
reattach to Harness stdout/stderr collectors from an earlier Host process; if
the old process is still running, the Supervisor terminates it using the
persisted Run grace period and reports `recovery-required`.
