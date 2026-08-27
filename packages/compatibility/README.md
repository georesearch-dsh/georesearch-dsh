# @georesearch/dsh-compat-rc5

This package is the compatibility boundary for DeepSeek Harness `0.1.0-rc.5`.
GeoResearch runtime packages consume these wrappers instead of importing
Harness services directly.

The `./client` export is the equivalent boundary for browser code. It exposes
only the rc.5 client types and UI atoms used by GeoResearch; the file-service
bundle inlines this facade while leaving Harness platform modules external to
the frozen Web loader table.

Before a tool is registered or a one-shot subagent is started, complete
GeoResearch JSON Schemas are projected into the smaller schema subset enforced
by Harness rc.5. The registered local Harness patch enforces array `minItems`
and `maxItems`, so projection preserves both constraints. One-shot structured
output must also have an explicit object root. Other unsupported display
constraints are removed only from the model-facing schema; strict runtime
parsers and standalone persisted schemas remain authoritative.
