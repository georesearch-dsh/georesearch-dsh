import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentSetupCommit } from '@georesearch/dsh-compat-rc5'
import { describe, expect, it, vi } from 'vitest'
import { createGeoResearchResumeSetup } from '../src/index.js'

describe('GeoResearch resume setup', () => {
  it('mounts the durable preset before the publication commit', async () => {
    let livePreset: string | undefined
    const assertCurrent = vi.fn()
    const mount = vi.fn(async (_agentContext: Context, preset: string) => {
      livePreset = preset
      return { id: preset }
    })
    const ctx = {
      geoResearchInstallation: { assertCurrent },
      agentPresets: {
        mount,
        composedPreset: () => livePreset,
      },
    } as unknown as Context
    const agent = resumeAgent()
    const agentContext = { agent } as unknown as Context
    const commit = await createGeoResearchResumeSetup(ctx)(agentContext) as AgentSetupCommit
    expect(mount).toHaveBeenCalledWith(agentContext, 'georesearch')
    expect(assertCurrent).not.toHaveBeenCalled()
    commit.commit()
    expect(assertCurrent).toHaveBeenCalledOnce()
  })

  it('rejects delegated sessions before mounting a root preset', async () => {
    const mount = vi.fn()
    const ctx = {
      geoResearchInstallation: { assertCurrent: vi.fn() },
      agentPresets: { mount, composedPreset: () => undefined },
    } as unknown as Context
    const agentContext = { agent: resumeAgent('subagent') } as unknown as Context
    await expect(createGeoResearchResumeSetup(ctx)(agentContext)).rejects.toMatchObject({
      code: 'DELEGATED_SESSION_RESUME_FORBIDDEN',
    })
    expect(mount).not.toHaveBeenCalled()
  })

  it('uses the latest durable preset event instead of the stale header', async () => {
    let livePreset: string | undefined
    const mount = vi.fn(async (_agentContext: Context, preset: string) => {
      livePreset = preset
      return { id: preset }
    })
    const ctx = {
      geoResearchInstallation: { assertCurrent: vi.fn() },
      agentPresets: { mount, composedPreset: () => livePreset },
    } as unknown as Context
    const agentContext = {
      agent: resumeAgent(undefined, 'legacy-preset', 'georesearch'),
    } as unknown as Context

    const commit = await createGeoResearchResumeSetup(ctx)(agentContext) as AgentSetupCommit
    expect(mount).toHaveBeenCalledWith(agentContext, 'georesearch')
    commit.commit()
  })

  it('rejects a live composed preset change before publication commit', async () => {
    let livePreset: string | undefined
    const assertCurrent = vi.fn()
    const ctx = {
      geoResearchInstallation: { assertCurrent },
      agentPresets: {
        mount: vi.fn(async (_agentContext: Context, preset: string) => {
          livePreset = preset
          return { id: preset }
        }),
        composedPreset: () => livePreset,
      },
    } as unknown as Context
    const agentContext = { agent: resumeAgent() } as unknown as Context
    const commit = await createGeoResearchResumeSetup(ctx)(agentContext) as AgentSetupCommit

    livePreset = 'legacy-preset'
    expect(() => commit.commit()).toThrow(/GEORESEARCH_PRESET_REQUIRED/)
    expect(assertCurrent).not.toHaveBeenCalled()
  })
})

function resumeAgent(
  origin?: 'subagent',
  headerPreset = 'georesearch',
  selectedPreset?: string,
): Agent {
  return {
    id: 'resume-session',
    session: {
      id: 'resume-session',
      header: {
        agentPreset: headerPreset,
        ...(origin === undefined ? {} : { origin }),
      },
      events: selectedPreset === undefined ? [] : [{
        type: 'agent-preset/selected',
        data: { agentPreset: selectedPreset },
      }],
    },
  } as unknown as Agent
}
