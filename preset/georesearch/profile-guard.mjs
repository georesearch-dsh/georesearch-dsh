export const name = 'georesearch-profile-guard'

export function apply(ctx) {
  if (ctx.get('geoResearchInstallation', false) !== undefined) return
  throw new Error(
    'GeoResearch preset requires an installer-integrated Web Profile; stop Harness, run georesearch-dsh upgrade, then restart the same Profile',
  )
}
