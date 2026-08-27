import { describe, expect, it } from 'vitest'
import { detectFileType, isReadableAttachmentType, normalizeUploadName } from '../src/media.js'

describe('byte-derived file classification', () => {
  it('ignores a misleading PDF name when the bytes are plain text', () => {
    expect(detectFileType(Buffer.from('plain scientific notes\n'), 'claimed.pdf')).toMatchObject({
      mediaType: 'text/plain',
      contentKind: 'text',
      readStrategy: 'direct-text',
      extension: '.pdf',
      parserProvenance: { evidence: 'text-sniff' },
    })
  })

  it('recognizes common documents, scientific data, images, and unsupported archives by magic bytes', () => {
    expect(detectFileType(Buffer.from('%PDF-1.7\n'), 'notes.txt')).toMatchObject({
      mediaType: 'application/pdf',
      contentKind: 'document',
      readStrategy: 'document',
    })
    expect(detectFileType(Buffer.from('SQLite format 3\0'), 'data.bin')).toMatchObject({
      mediaType: 'application/vnd.sqlite3',
      contentKind: 'data',
      readStrategy: 'data',
      parserProvenance: { contentParser: 'sqlite' },
    })
    expect(detectFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'plot.dat'))
      .toMatchObject({ mediaType: 'image/png', readStrategy: 'image' })
    expect(detectFileType(Buffer.from([0x49, 0x49, 0x2a, 0x00]), 'plot.dat'))
      .toMatchObject({ mediaType: 'image/tiff', readStrategy: 'image', parserProvenance: { contentParser: 'tiff' } })
    expect(detectFileType(Buffer.from('BM'), 'plot.dat'))
      .toMatchObject({ mediaType: 'image/bmp', readStrategy: 'image', parserProvenance: { contentParser: 'bmp' } })
    expect(detectFileType(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), 'bundle.7z'))
      .toMatchObject({ archive: { format: '7z', supported: false }, readStrategy: 'metadata-only' })
  })

  it('classifies modern document containers and notebooks as directly readable content', () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04])
    expect(detectFileType(zip, 'paper.docx')).toMatchObject({ readStrategy: 'document', parserProvenance: { contentParser: 'openxml' } })
    expect(detectFileType(zip, 'slides.odp')).toMatchObject({ readStrategy: 'document', parserProvenance: { contentParser: 'opendocument' } })
    expect(detectFileType(zip, 'book.epub')).toMatchObject({ readStrategy: 'document', parserProvenance: { contentParser: 'epub' } })
    expect(detectFileType(Buffer.from('{"cells":[]}'), 'analysis.ipynb')).toMatchObject({
      mediaType: 'application/x-ipynb+json',
      readStrategy: 'document',
      parserProvenance: { contentParser: 'jupyter' },
    })
  })

  it('classifies legacy Office and bounded scientific formats as readable content', () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    expect(detectFileType(ole, 'paper.doc')).toMatchObject({ mediaType: 'application/msword', readStrategy: 'document', parserProvenance: { contentParser: 'legacy-doc' } })
    expect(detectFileType(ole, 'table.xls')).toMatchObject({ mediaType: 'application/vnd.ms-excel', readStrategy: 'document', parserProvenance: { contentParser: 'legacy-xls' } })
    expect(detectFileType(ole, 'slides.ppt')).toMatchObject({ mediaType: 'application/vnd.ms-powerpoint', readStrategy: 'document', parserProvenance: { contentParser: 'legacy-ppt' } })
    expect(detectFileType(ole, 'unknown.ole')).toMatchObject({ mediaType: 'application/x-ole-storage', readStrategy: 'provider-required' })
    expect(detectFileType(Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]), 'data.h5'))
      .toMatchObject({ readStrategy: 'data', parserProvenance: { contentParser: 'hdf5' } })
    expect(detectFileType(Buffer.from([0x43, 0x44, 0x46, 0x01]), 'data.nc'))
      .toMatchObject({ readStrategy: 'data', parserProvenance: { contentParser: 'netcdf' } })
    expect(detectFileType(Buffer.from('PAR1'), 'data.parquet'))
      .toMatchObject({ readStrategy: 'data', parserProvenance: { contentParser: 'parquet' } })
    expect(detectFileType(Buffer.from([0x43, 0x44, 0x46, 0x05]), 'cdf5.nc'))
      .toMatchObject({ readStrategy: 'provider-required' })
  })

  it('recognizes mainstream source-code names and extensions as readable text', () => {
    const cases = [
      ['main.c', 'text/x-c'],
      ['main.cpp', 'text/x-c++'],
      ['Program.cs', 'text/x-csharp'],
      ['script.py', 'text/x-python'],
      ['analysis.r', 'text/x-r'],
      ['model.jl', 'text/x-julia'],
      ['app.js', 'text/javascript'],
      ['view.tsx', 'text/typescript'],
      ['lib.rs', 'text/x-rust'],
      ['main.go', 'text/x-go'],
      ['Model.java', 'text/x-java-source'],
      ['service.kt', 'text/x-kotlin'],
      ['App.swift', 'text/x-swift'],
      ['analysis.m', 'text/x-matlab'],
      ['index.php', 'text/x-php'],
      ['job.rb', 'text/x-ruby'],
      ['script.pl', 'text/x-perl'],
      ['init.lua', 'text/x-lua'],
      ['app.dart', 'text/x-dart'],
      ['Build.scala', 'text/x-scala'],
      ['build.gradle', 'text/x-groovy'],
      ['Token.sol', 'text/x-solidity'],
      ['solver.f90', 'text/x-fortran'],
      ['module.sv', 'text/x-systemverilog'],
      ['entity.vhdl', 'text/x-vhdl'],
      ['boot.asm', 'text/x-asm'],
      ['kernel.cu', 'text/x-cuda'],
      ['filter.cl', 'text/x-opencl'],
      ['Program.fs', 'text/x-fsharp'],
      ['mix.exs', 'text/x-elixir'],
      ['server.erl', 'text/x-erlang'],
      ['core.clj', 'text/x-clojure'],
      ['Main.hs', 'text/x-haskell'],
      ['parser.ml', 'text/x-ocaml'],
      ['app.nim', 'text/x-nim'],
      ['main.zig', 'text/x-zig'],
      ['run.sh', 'text/x-shellscript'],
      ['deploy.ps1', 'text/x-powershell'],
      ['build.cmd', 'text/x-batch'],
      ['query.sql', 'application/sql'],
      ['schema.graphql', 'application/graphql'],
      ['messages.proto', 'text/x-protobuf'],
      ['module.wat', 'text/x-webassembly'],
      ['component.vue', 'text/x-vue'],
      ['component.svelte', 'text/x-svelte'],
      ['page.astro', 'text/x-astro'],
      ['Dockerfile', 'text/x-dockerfile'],
      ['CMakeLists.txt', 'text/x-cmake'],
    ] as const
    for (const [name, mediaType] of cases) {
      expect(detectFileType(Buffer.from('source code\n'), name)).toMatchObject({
        mediaType,
        contentKind: 'text',
        readStrategy: 'direct-text',
        parserProvenance: { contentParser: 'text' },
      })
    }
  })

  it('keeps unknown UTF-8 and UTF-16 source-like text readable', () => {
    expect(detectFileType(Buffer.from('custom_language statement\n'), 'model.custom')).toMatchObject({
      mediaType: 'text/plain',
      contentKind: 'text',
      readStrategy: 'direct-text',
    })
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('program main\nend', 'utf16le')])
    expect(detectFileType(utf16, 'solver.unknown')).toMatchObject({
      mediaType: 'text/plain',
      contentKind: 'text',
      readStrategy: 'direct-text',
    })
  })

  it('distinguishes recognized formats from formats that are allowed to complete upload', () => {
    expect(isReadableAttachmentType(detectFileType(Buffer.from('print(1)'), 'main.py'))).toBe(true)
    expect(isReadableAttachmentType(detectFileType(Buffer.from('SQLite format 3\0'), 'data.sqlite'))).toBe(true)
    expect(isReadableAttachmentType(detectFileType(Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]), 'data.h5'))).toBe(true)
    expect(isReadableAttachmentType(detectFileType(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), 'archive.7z'))).toBe(false)
  })

  it('strips any supplied path and rejects an empty unsafe name', () => {
    expect(normalizeUploadName('C:\\fake\\path\\report.csv')).toBe('report.csv')
    expect(() => normalizeUploadName('../')).toThrow(/empty or unsafe/)
  })
})
