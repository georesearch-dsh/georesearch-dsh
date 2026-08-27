import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Python worker protocol', () => {
  it('completes the hello and cancellation probe', () => {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/probe-python-worker.ts'],
      {
        cwd: resolve(import.meta.dirname, '..'),
        encoding: 'utf8',
        shell: false,
        timeout: 15_000,
      },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      hello: true,
      deadline: true,
      cancellation: true,
      exitCode: 0,
    })
  })
})
