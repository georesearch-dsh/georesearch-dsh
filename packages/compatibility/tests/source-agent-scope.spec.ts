import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const workspaceRoot = resolve(import.meta.dirname, '../../..')
const harnessRoot = resolve(workspaceRoot, '..', 'deepseek-harness-master')
const temporaryRoot = join(workspaceRoot, '.tmp')
let stagedProfile: string

beforeAll(async () => {
  await mkdir(temporaryRoot, { recursive: true })
  stagedProfile = await mkdtemp(join(temporaryRoot, 'source-agent-scope-'))

  const compatibilityTarget = join(
    stagedProfile,
    'node_modules',
    '@georesearch',
    'dsh-compat-rc5',
  )
  await mkdir(compatibilityTarget, { recursive: true })
  await cp(
    join(workspaceRoot, 'packages', 'compatibility', 'lib'),
    join(compatibilityTarget, 'lib'),
    { recursive: true },
  )
  await cp(
    join(workspaceRoot, 'packages', 'compatibility', 'package.json'),
    join(compatibilityTarget, 'package.json'),
  )

  const scopeTarget = join(stagedProfile, 'node_modules', '@deepseek-ai', 'dsh-scope')
  await mkdir(scopeTarget, { recursive: true })
  await cp(
    join(harnessRoot, 'packages', 'core', 'scope', 'lib'),
    join(scopeTarget, 'lib'),
    { recursive: true },
  )
  await cp(
    join(harnessRoot, 'packages', 'core', 'scope', 'package.json'),
    join(scopeTarget, 'package.json'),
  )
})

afterAll(async () => {
  await rm(stagedProfile, { recursive: true, force: true })
})

describe('Harness source launcher compatibility', () => {
  it('reads the visible tool catalog from a real source-created Agent', () => {
    const compatibilityUrl = pathToFileURL(join(
      stagedProfile,
      'node_modules',
      '@georesearch',
      'dsh-compat-rc5',
      'lib',
      'index.js',
    )).href
    const probe = `
      import { Context } from '@deepseek-ai/cordis'
      import LlmRuntime from '@deepseek-ai/dsh-llm'
      import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
      import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
      import ToolRuntime from '@deepseek-ai/dsh-tools'
      import AgentRegistry from '@deepseek-ai/dsh-agent'
      import { scopeOf } from '@deepseek-ai/dsh-scope'
      import AgentLoop from '@deepseek-ai/dsh-agent-loop'

      const compatibility = await import(process.env.GEORESEARCH_COMPAT_PROBE_URL)
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SystemPrompt, { persona: 'GeoResearch scope probe' })
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      const handle = await ctx.agents.create({ sessionId: SessionId('georesearch-scope-probe') })
      const result = { harnessScopeMatches: scopeOf(handle.agent.ctx) === handle.agent }
      try {
        result.visibleToolNames = compatibility.visibleToolNames(ctx, handle.agent.ctx)
      } catch (error) {
        result.error = String(error)
      }
      console.log(JSON.stringify(result))
      await handle.dispose()
      await ctx.fiber.dispose()
    `
    const result = spawnSync(
      process.execPath,
      [
        // tsx otherwise calls os.userInfo() on Windows, which can fail in sandboxed/service contexts.
        '--import',
        'data:text/javascript,process.geteuid??=()=>0',
        '--import',
        'tsx/esm',
        '--input-type=module',
        '--eval',
        probe,
      ],
      {
        cwd: harnessRoot,
        encoding: 'utf8',
        env: { ...process.env, GEORESEARCH_COMPAT_PROBE_URL: compatibilityUrl },
        timeout: 30_000,
      },
    )

    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const output = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? '{}') as {
      harnessScopeMatches?: boolean
      visibleToolNames?: string[]
      error?: string
    }
    expect(output).toEqual({
      harnessScopeMatches: true,
      visibleToolNames: [],
    })
  })
})
