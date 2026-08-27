import { Context } from '@deepseek-ai/cordis'
import { apply } from '@georesearch/dsh-installation-guard'

const homeIndex = process.argv.indexOf('--home')
const home = homeIndex < 0 ? undefined : process.argv[homeIndex + 1]
if (home === undefined) throw new Error('maintenance probe requires --home')

const ctx = new Context()
try {
  await apply(ctx, { home, pollIntervalMs: 60_000 })
  ctx.geoResearchInstallation.assertCurrent()
  process.stdout.write(`${JSON.stringify({
    generation: ctx.geoResearchInstallation.active.generation,
    installationId: ctx.geoResearchInstallation.active.installationId,
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
