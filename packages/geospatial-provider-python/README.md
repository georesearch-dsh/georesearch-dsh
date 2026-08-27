# `@georesearch/dsh-geospatial-provider-python`

Phase 5 persistent Python provider. It starts only the fixed argv
`<configured-python> -u -m georesearch_worker` through the Harness subprocess
seam, speaks bounded NDJSON over pipes, supports request deadlines and
cancellation, rejects every in-flight request on worker failure, and drains,
terminates, and joins during disposal. Dataset paths exist only inside the
Host/provider request and are never returned to the model.
