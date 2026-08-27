import { describe, expect, it } from 'vitest'
import { phase2HostToolNames } from '../src/phase2-probe.js'

describe('Phase 2 runtime probe contract', () => {
  it('requires exactly the new Project and Run host tools', () => {
    expect(phase2HostToolNames()).toEqual([
      'artifact_commit',
      'artifact_read',
      'deliverable_publish',
      'formal_run_candidate',
      'formal_run_submit',
      'local_test_run',
      'research_brief_commit',
      'research_project_status',
      'run_cancel',
      'run_record_read',
      'run_status',
    ])
  })
})
