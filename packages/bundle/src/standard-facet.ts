import { defineFacet } from '@dsh-std/sdk'
import type { ExecutableToolDefinition, ToolOverrideHandler } from '@dsh-std/tool'
import {
  DSH_STANDARD_TOOL_OVERRIDE_REFERENCE,
  GEORESEARCH_STANDARD_TOOL_TARGETS,
} from './standard-catalog.js'

const passThroughOverride: ToolOverrideHandler = Object.freeze({
  resolve(original: ExecutableToolDefinition): ExecutableToolDefinition {
    return original
  },
})

export const facet = defineFacet(
  context => {
    for (const target of GEORESEARCH_STANDARD_TOOL_TARGETS) {
      context.extensions.publish(
        DSH_STANDARD_TOOL_OVERRIDE_REFERENCE,
        target,
        passThroughOverride,
      )
    }
  },
  undefined,
  () => Object.freeze({
    state: 'active' as const,
    message: 'GeoResearch rc.5 tools are owned by a DSH Standard lifecycle facet.',
  }),
)

export default facet
