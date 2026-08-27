export const DSH_STANDARD_AUDIT_REVISION = 'bb194ad53a72f4fa7da1286c88dcebb488b43eb9'
export const DSH_STANDARD_MANIFEST_VERSION = '0.15'
export const DSH_STANDARD_SCHEMA_URI = `https://raw.githubusercontent.com/Yan-Zero/dsh-std/${DSH_STANDARD_AUDIT_REVISION}/packages/manifest/schema/dsh-plugin-0.15.schema.json`
export const DSH_STANDARD_MANIFEST_SCHEMA_CANONICAL_SHA256 = 'f0d0a2843eaa1f2b50d7f29b3059aec3a00a5604375edd367a8ca3464813b89c'
export const DSH_STANDARD_DIRECT_PACKAGE_VERSIONS = Object.freeze({
  '@dsh-std/adapter-dsh': '0.1.1-rc.1',
  '@dsh-std/manifest': '0.1.1-rc.1',
  '@dsh-std/sdk': '0.1.1-rc.1',
  '@dsh-std/tool': '0.1.1-rc.1',
} as const)
export const DSH_STANDARD_ADAPTER_VERSION = DSH_STANDARD_DIRECT_PACKAGE_VERSIONS['@dsh-std/adapter-dsh']
export const DSH_STANDARD_TOOL_API_VERSION = 'tools.dsh/v1alpha1'
export const DSH_STANDARD_TOOL_OVERRIDE_KIND = 'ToolOverride'

/**
 * GeoResearch tools already implemented by the rc.5 Cordis runtime. The
 * standard facet publishes execution-only ToolOverride ownership so the
 * adapter can apply lifecycle, provenance, and cleanup without changing the
 * mature tool implementations or their role policy.
 */
export const GEORESEARCH_STANDARD_TOOL_TARGETS = Object.freeze([
  'archive_list',
  'archive_read',
  'artifact_commit',
  'artifact_read',
  'attachment_inspect',
  'attachment_list',
  'attachment_read',
  'attachment_read_image',
  'citation_check',
  'citation_validate',
  'claim_commit',
  'delegate_experiment',
  'delegate_literature',
  'delegate_review',
  'delegate_writing',
  'delegation_bootstrap',
  'deliverable_publish',
  'evidence_candidate',
  'experiment_spec_candidate',
  'experiment_spec_commit',
  'experiment_validate',
  'formal_run_candidate',
  'formal_run_submit',
  'geodata_inspect',
  'geodata_validate',
  'literature_continue',
  'literature_search',
  'local_test_run',
  'manuscript_candidate',
  'manuscript_validate',
  'paper_read',
  'repository_audit',
  'reproduction_plan_candidate',
  'research_brief_commit',
  'research_project_status',
  'result_commit',
  'result_read',
  'review_candidate',
  'review_subject_read',
  'run_cancel',
  'run_record_read',
  'run_status',
  'source_resolve',
  'test_spec_candidate',
  'writing_packet_build',
  'writing_packet_read',
] as const)

export const DSH_STANDARD_TOOL_OVERRIDE_REFERENCE = Object.freeze({
  apiVersion: DSH_STANDARD_TOOL_API_VERSION,
  kind: DSH_STANDARD_TOOL_OVERRIDE_KIND,
})

export function standardToolContributionId(target: string): string {
  return `org.deepseek.georesearch.tool.${target.replaceAll('_', '-')}`
}

export function standardToolOverrideDescription(target: string): string {
  return `Apply standard lifecycle ownership to the existing GeoResearch ${target} tool without changing its execution contract.`
}
