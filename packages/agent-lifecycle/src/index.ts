import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import {
  agentFromContext,
  durablePreset,
  livePreset,
  mountPreset,
  resumeThroughHarness,
  sessionOrigin,
  setupCommit,
  type AgentHandle,
  type AgentOptions,
  type AgentSetup,
  type SessionId,
} from '@georesearch/dsh-compat-rc5'
import { GeoResearchError, PRESET_ID } from '@georesearch/dsh-contracts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    geoResearchAgentLifecycle: GeoResearchAgentLifecycle
  }
}

export const name = 'georesearch-agent-lifecycle'
export const inject = ['geoResearchInstallation', 'geoResearchPolicy', 'agents', 'agentPresets']

export interface GeoResearchResumeOptions {
  readonly agentOptions?: Omit<AgentOptions, 'geoResearchRole'>
  readonly signal?: AbortSignal
}

export class GeoResearchAgentLifecycle extends Service {
  constructor(ctx: Context) {
    super(ctx, 'geoResearchAgentLifecycle')
  }

  async resume(
    resumeSessionId: SessionId,
    options: GeoResearchResumeOptions = {},
  ): Promise<AgentHandle> {
    this.ctx.geoResearchInstallation.assertCurrent()
    if (options.agentOptions !== undefined && 'geoResearchRole' in options.agentOptions) {
      throw new GeoResearchError(
        'GEORESEARCH_ROLE_MISMATCH',
        'root resume callers cannot provide geoResearchRole',
      )
    }
    return resumeThroughHarness(this.ctx, {
      resumeSessionId,
      ...(options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      setup: createGeoResearchResumeSetup(this.ctx),
    })
  }
}

export function createGeoResearchResumeSetup(ctx: Context): AgentSetup {
  return async (agentContext) => {
    const agent = agentFromContext(agentContext)
    if (sessionOrigin(agent) === 'subagent') {
      throw new GeoResearchError(
        'DELEGATED_SESSION_RESUME_FORBIDDEN',
        `delegated session ${String(agent.id)} cannot be resumed as a root agent`,
      )
    }
    const preset = durablePreset(agent.session)
    if (preset !== PRESET_ID) {
      throw new GeoResearchError(
        'GEORESEARCH_PRESET_REQUIRED',
        `session ${String(agent.id)} resolves durable preset ${JSON.stringify(preset)}, not ${PRESET_ID}`,
      )
    }
    await mountPreset(ctx, agentContext, PRESET_ID)
    return setupCommit(() => {
      if (livePreset(ctx, agentContext) !== PRESET_ID) {
        throw new GeoResearchError(
          'GEORESEARCH_PRESET_REQUIRED',
          'live composed preset changed before publication commit',
        )
      }
      ctx.geoResearchInstallation.assertCurrent()
    })
  }
}

export function apply(ctx: Context): void {
  new GeoResearchAgentLifecycle(ctx)
}
