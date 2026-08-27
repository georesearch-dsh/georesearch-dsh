import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RUNTIME_PACKAGE_NAMES } from '../src/distribution.js'
import { planProfileIntegrations, planProfileRemoval } from '../src/profile-integration.js'

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

describe('Web Profile integration planning', () => {
  it('discovers every Web bundle regardless of Profile name and ignores non-Web profiles', async () => {
    const home = await temporaryHome()
    await writeProfile(home, 'web')
    await writeProfile(home, 'field-station')
    await writeProfile(home, 'headless', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])

    const plan = await planProfileIntegrations(home, [], undefined)
    expect(plan.profiles.map(profile => profile.profileName)).toEqual(['field-station', 'web'])
    for (const profile of plan.profiles) {
      const packageMutation = profile.mutations.find(mutation => mutation.path === 'package.json')
      expect(packageMutation).toBeDefined()
      const manifest = JSON.parse(Buffer.from(packageMutation!.bytes).toString('utf8')) as {
        dependencies: Record<string, string>
        dsh: { profile: { bundles: string[] } }
      }
      for (const packageName of RUNTIME_PACKAGE_NAMES) {
        expect(manifest.dependencies[packageName]).toBe('0.1.0')
      }
      expect(manifest.dsh.profile.bundles.at(-1)).toBe('@georesearch/dsh-bundle')
    }
  })

  it('rejects unmanaged GeoResearch dependency ownership conflicts', async () => {
    const home = await temporaryHome()
    await writeProfile(home, 'web', undefined, { '@georesearch/dsh-prompt': 'file:../manual' })
    await expect(planProfileIntegrations(home, [], undefined)).rejects.toThrow(/conflicting dependency/)
  })

  it('removes only installer-owned fields while preserving later user additions', async () => {
    const home = await temporaryHome()
    const dependencies = Object.fromEntries(RUNTIME_PACKAGE_NAMES.map(name => [name, '0.1.0']))
    dependencies['later-user-package'] = '9.9.9'
    await writeProfile(
      home,
      'portable-web',
      ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@georesearch/dsh-bundle'],
      dependencies,
      { retained: true },
    )

    const plan = await planProfileRemoval(home, ['portable-web'], '0.1.0')
    const mutation = plan.profiles[0]!.mutations[0]!
    const manifest = JSON.parse(Buffer.from(mutation.bytes).toString('utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
      userOwned: { retained: boolean }
    }
    expect(manifest.dependencies).toEqual({ 'later-user-package': '9.9.9' })
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
    ])
    expect(manifest.userOwned).toEqual({ retained: true })
  })
})

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'georesearch-profile-plan-'))
  homes.push(home)
  return home
}

async function writeProfile(
  home: string,
  profileName: string,
  bundles: readonly string[] = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  dependencies: Readonly<Record<string, string>> = {},
  userOwned?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const root = join(home, 'profiles', profileName)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${profileName}`,
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
    ...(userOwned === undefined ? {} : { userOwned }),
  }, undefined, 2)}\n`)
  await writeFile(join(root, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  await readFile(join(root, 'package.json'))
}
