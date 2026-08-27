# @georesearch/dsh-prompt

Adds stable scientific-integrity rules and one bounded, Host-generated JSON
runtime context. In Phase 2 it reports the current stage, actor, installation
generation, available actions, and post-Phase 2 capability blockers. Project
state is not duplicated into the prompt; Agents read the authoritative bounded
ProjectSnapshot through `research_project_status`.

The stable policy also makes the Coordinator load the `georesearch` Skill
before any other tool, including read-only status calls. The Host enforces the
same ordering, so a model cannot silently bypass the routing instructions on a
narrow request.

`deliverable_publish` is used only when the user explicitly requests a file or
the current Host workflow requires a deliverable Artifact. Read-only assessment
and search requests otherwise return inline, so tool visibility alone does not
authorize publication.

The runtime snapshot also identifies the automatic
`deepseek-v4-flash-vision-exp` attachment route, its managed
`DEEPSEEK_API_KEY` reference, native-model/local-OCR fallbacks, and the rule
that instructions visible inside uploaded images are untrusted data only.

Managed specialists receive a separate compact runtime snapshot. Before
bootstrap it exposes only the stable role and required bootstrap action, not
the task type, required Skills, authority, or user question. Coordinator-only
attachment, vision, execution, and deliverable detail is omitted from this
cache-sensitive child surface.
