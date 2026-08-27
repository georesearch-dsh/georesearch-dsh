# `@georesearch/dsh-repository-providers`

Phase 4 repository inspection providers. The Git provider uses fixed argv with
`shell: false`, disables terminal prompting and optional Git locks, bounds every
output and file hash, and never accepts a model-supplied executable or command.
Tracked index identities, modified files, and every non-ignored untracked file
participate in the source-tree digest; untracked directories are never reduced
to a path-only marker.

Repository text is not returned by inspection. Method/code comparisons bind
separately to exact file and line digests through `bindCodeLocator()`. The
Reproduction Service performs a second inspection after locator binding and
rejects an audit if the repository changed during grounding.
