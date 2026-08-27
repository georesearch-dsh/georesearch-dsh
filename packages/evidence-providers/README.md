# GeoResearch Evidence Providers

Replay-safe literature provider interfaces, shared rate limiting, and the
bounded Crossref read provider used by Phase 3.

Crossref continuation state is a bounded stateless offset. The Provider does
not use Crossref's stateful scroll cursor because repeating the same cursor can
advance the upstream search and skip a page during crash recovery.
