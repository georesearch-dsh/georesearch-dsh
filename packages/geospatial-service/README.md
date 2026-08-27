# `@georesearch/dsh-geospatial-service`

Phase 5 Host service for `geodata_inspect`. It resolves only current committed
Artifacts, passes their content-addressed paths to the persistent Python
provider, validates the complete response against the shared contracts, and
can re-run an inspection before a Coordinator commits the corresponding
DatasetManifest. Artifact paths never cross the tool boundary.
