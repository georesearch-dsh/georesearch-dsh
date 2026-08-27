# @georesearch/dsh-agent-lifecycle

Provides `ctx.geoResearchAgentLifecycle.resume()`. The wrapper rejects delegated
sessions inside `ResumeAgentOptions.setup`, resolves durable identity through
`resolveSessionPreset()`, mounts the managed preset, and rechecks live identity
in the synchronous publication commit.
