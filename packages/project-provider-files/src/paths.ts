import { join, resolve } from 'node:path'

export interface ProjectPaths {
  readonly root: string
  readonly state: string
  readonly events: string
  readonly objects: string
  readonly objectSha256: string
  readonly runs: string
  readonly continuations: string
  readonly temp: string
  readonly operations: string
  readonly attachments: string
}

export function projectRoot(home: string): string {
  return join(resolve(home), 'georesearch', 'projects')
}

export function projectPaths(home: string, projectId: string): ProjectPaths {
  assertId(projectId, 'projectId')
  const root = join(projectRoot(home), projectId)
  return {
    root,
    state: join(root, 'state.json'),
    events: join(root, 'events.jsonl'),
    objects: join(root, 'objects'),
    objectSha256: join(root, 'objects', 'sha256'),
    runs: join(root, 'runs'),
    continuations: join(root, 'continuations'),
    temp: join(root, 'temp'),
    operations: join(root, 'operations'),
    attachments: join(root, 'attachments'),
  }
}

export function assertId(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new TypeError(`${field} must be a contained portable identifier`)
  }
}
