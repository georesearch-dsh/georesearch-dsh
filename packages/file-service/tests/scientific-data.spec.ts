import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parquetWriteBuffer } from 'hyparquet-writer'
import { afterEach, describe, expect, it } from 'vitest'
import { readScientificAttachment } from '../src/scientific-data.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('scientific data reading', () => {
  it('traverses HDF5 groups, attributes, and bounded dataset samples without following external links', async () => {
    const path = await fixturePath('observations.h5', Buffer.alloc(0))
    const h5 = await import('h5wasm/node')
    await h5.ready
    const file = new h5.File(path, 'w')
    const entry = file.create_group('entry')
    entry.create_attribute('title', 'GeoResearch observations')
    entry.create_dataset({ name: 'temperature', data: new Float64Array([18.5, 19.25, 20]), shape: [3] })
    entry.create_external_link('missing-external.h5', '/remote', 'external-data')
    file.close()

    const result = await readScientificAttachment(path, 'application/x-hdf5')
    expect(result.format).toBe('hdf5')
    expect(result.text).toContain('Group: /entry')
    expect(result.text).toContain('Attribute title: "GeoResearch observations"')
    expect(result.text).toContain('Dataset: /entry/temperature')
    expect(result.text).toContain('18.5')
    expect(result.text).toContain('missing-external.h5:/remote [not followed]')
  })

  it('reads NetCDF classic dimensions, variables, and bounded values', async () => {
    const path = await fixturePath('observations.nc', minimalNetcdf())
    const result = await readScientificAttachment(path, 'application/x-netcdf')
    expect(result.format).toBe('netcdf')
    expect(result.text).toContain('Format: classic format')
    expect(result.text).toContain('- observation: 2')
    expect(result.text).toContain('### temperature')
    expect(result.text).toContain('18.5')
    expect(result.text).toContain('19.25')
  })

  it('reads Parquet schema and a bounded row sample', async () => {
    const bytes = parquetWriteBuffer({
      codec: 'UNCOMPRESSED',
      columnData: [
        { name: 'station', data: ['A', 'B', 'C'], type: 'STRING' },
        { name: 'temperature', data: [18, 19, 20], type: 'INT32' },
      ],
    })
    const path = await fixturePath('observations.parquet', new Uint8Array(bytes))
    const result = await readScientificAttachment(path, 'application/vnd.apache.parquet')
    expect(result.format).toBe('parquet')
    expect(result.text).toContain('Rows: 3')
    expect(result.text).toContain('station')
    expect(result.text).toContain('temperature')
    expect(result.text).toContain('"station":"A"')
    expect(result.text).toContain('"temperature":18')
  })
})

async function fixturePath(name: string, bytes: Uint8Array): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'georesearch-scientific-'))
  roots.push(root)
  const path = join(root, name)
  await writeFile(path, bytes)
  return path
}

function minimalNetcdf(): Buffer {
  const dimensions = Buffer.concat([
    uint32(10),
    uint32(1),
    ncString('observation'),
    uint32(2),
  ])
  const variableWithoutOffset = Buffer.concat([
    ncString('temperature'),
    uint32(1),
    uint32(0),
    absentList(),
    uint32(5),
    uint32(8),
    uint32(0),
  ])
  const header = Buffer.concat([
    Buffer.from([0x43, 0x44, 0x46, 0x01]),
    uint32(0),
    dimensions,
    absentList(),
    uint32(11),
    uint32(1),
    variableWithoutOffset,
  ])
  header.writeUInt32BE(header.byteLength, header.byteLength - 4)
  const values = Buffer.alloc(8)
  values.writeFloatBE(18.5, 0)
  values.writeFloatBE(19.25, 4)
  return Buffer.concat([header, values])
}

function absentList(): Buffer {
  return Buffer.concat([uint32(0), uint32(0)])
}

function ncString(value: string): Buffer {
  const bytes = Buffer.from(value, 'ascii')
  const padding = Buffer.alloc((4 - (bytes.byteLength % 4)) % 4)
  return Buffer.concat([uint32(bytes.byteLength), bytes, padding])
}

function uint32(value: number): Buffer {
  const output = Buffer.alloc(4)
  output.writeUInt32BE(value)
  return output
}
