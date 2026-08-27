import { readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const lib = resolve(import.meta.dirname, '..', 'packages', 'file-service', 'lib')
const exactFiles = new Set([
  'client.js',
  'client.js.map',
  'index.js',
  'index.js.map',
  'pdf.js',
  'pdf.js.map',
])

let entries
try {
  entries = await readdir(lib, { withFileTypes: true })
} catch (error) {
  if (error?.code === 'ENOENT') process.exit(0)
  throw error
}

for (const entry of entries) {
  if (entry.name === 'assets' || exactFiles.has(entry.name) || /\.mjs(?:\.map)?$/u.test(entry.name)) {
    await rm(resolve(lib, entry.name), { recursive: true, force: true })
  }
}
