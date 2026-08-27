# @georesearch/dsh-provider-lifecycle

Shared provider lifecycle primitive for the Phase 1 foundation. Admission is
accepted only in `ACCEPTING`, drain rejects new work while awaiting every
accepted operation, and disposal runs cancellation and cleanup exactly once.
Provider packages use this primitive before publishing Phase 2 services.
