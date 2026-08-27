import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ToolExecution } from '@georesearch/dsh-compat-rc5'
import { describe, expect, it, vi } from 'vitest'
import {
  registerWorkspaceImageOverride,
  workspaceImageTool,
  type GeoResearchFileService,
  type ImageUnderstandingAnalyzer,
} from '../src/index.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
)

describe('workspace image vision routing', () => {
  it('uses DeepSeek vision for workspace PNG files even when the selected model is text-only', async () => {
    const analyze = vi.fn(async () => visionResult('A one-pixel test image.'))
    const target = { targetKey: 'fixture-image', displayPath: 'D:\\workspace\\figure.png' }
    const resolve = vi.fn(async () => target)
    const stat = vi.fn(async () => ({ type: 'file', version: 'fixture-version' }))
    const readBytes = vi.fn(async () => PNG)
    const observed = vi.fn()
    const resolveModelInfo = vi.fn(async () => ({ inputModalities: ['text'] }))
    const ctx = {
      fs: { resolve, stat, readBytes },
      get(name: string) {
        if (name === 'llm') return { resolveModelInfo }
        return undefined
      },
      emit: observed,
    } as unknown as Context
    const service = {
      imageUnderstandingAnalyzer: { analyze } as ImageUnderstandingAnalyzer,
    } as unknown as GeoResearchFileService
    const tool = workspaceImageTool(ctx, service)
    const args = { file_path: 'figure.png', question: 'What is shown?' }

    const value = await tool.execute(args, execution('deepseek-v4-pro'))
    const blocks = tool.output.render(args, value)

    expect(value).toMatchObject({
      path: 'D:\\workspace\\figure.png',
      sourceMediaType: 'image/png',
      mediaType: 'image/png',
      delivery: 'deepseek-vision',
      analysis: expect.objectContaining({ text: 'A one-pixel test image.' }),
    })
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({
      mediaType: 'image/png',
      purpose: 'standalone',
      question: 'What is shown?',
    }), expect.any(AbortSignal))
    expect(resolve).toHaveBeenCalledWith('figure.png', expect.objectContaining({ cwd: 'D:\\workspace' }))
    expect(readBytes).toHaveBeenCalledWith(target, expect.any(AbortSignal), expect.any(Number))
    expect(observed).toHaveBeenCalledWith(
      'fs/observed',
      target,
      { kind: 'present', version: 'fixture-version' },
      expect.anything(),
    )
    expect(resolveModelInfo).not.toHaveBeenCalled()
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('<georesearch-workspace-image-analysis'),
    }))
  })

  it('registers a scoped read_image override only for a live GeoResearch actor', () => {
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const agent = {
      ctx: { tools: { register } },
    } as unknown as Agent
    const service = {} as GeoResearchFileService
    const ctx = {
      geoResearchPolicy: { actorFor: () => 'coordinator' },
    } as unknown as Context

    expect(registerWorkspaceImageOverride(ctx, service, agent)).toBe(dispose)
    expect(register).toHaveBeenCalledOnce()
    expect(register.mock.calls[0]?.[0]).toMatchObject({
      name: 'read_image',
      description: expect.stringContaining('DeepSeek-V4-Flash-Vision-Exp'),
    })

    const outsiderRegister = vi.fn()
    const outsider = { ctx: { tools: { register: outsiderRegister } } } as unknown as Agent
    const outsiderCtx = {
      geoResearchPolicy: { actorFor: () => undefined },
    } as unknown as Context
    expect(registerWorkspaceImageOverride(outsiderCtx, service, outsider)).toBeUndefined()
    expect(outsiderRegister).not.toHaveBeenCalled()
  })
})

function execution(model: string): ToolExecution {
  return {
    agent: {
      id: 'workspace-image-agent',
      options: { provider: 'fixture', model },
      session: {
        id: 'workspace-image-session',
        header: { cwd: 'D:\\workspace' },
        requestHeader: () => undefined,
      },
    } as unknown as Agent,
    signal: new AbortController().signal,
  } as ToolExecution
}

function visionResult(text: string) {
  return {
    engine: 'deepseek-api/chat-completions' as const,
    provider: 'deepseek' as const,
    model: 'deepseek-v4-flash-vision-exp' as const,
    releaseDate: '2026-08-21' as const,
    text,
    finishReason: 'stop',
    requestId: 'workspace-image-request',
    usage: {
      promptTokens: 384,
      completionTokens: 20,
      totalTokens: 404,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 384,
      reasoningTokens: 0,
    },
    input: {
      mediaType: 'image/png' as const,
      bytes: PNG.byteLength,
      purpose: 'standalone' as const,
      detail: 'high' as const,
    },
    warnings: [],
  }
}
