import { randomBytes, randomUUID } from 'node:crypto'
import {
  protectMaintenanceNonce,
  unprotectMaintenanceNonce,
} from '../packages/installation-guard/src/nonce-protection.ts'

if (process.platform !== 'win32') throw new Error('the DPAPI probe is Windows-only')
const binding = {
  transactionId: randomUUID(),
  generation: 1,
  executable: process.execPath,
  deadline: new Date(Date.now() + 60_000).toISOString(),
}
const nonce = randomBytes(32).toString('base64url')
const protectedNonce = await protectMaintenanceNonce(nonce, binding)
if (protectedNonce.protection !== 'dpapi-current-user') throw new Error('the DPAPI probe selected a test fallback')
const opened = await unprotectMaintenanceNonce(protectedNonce.value, protectedNonce.protection, binding)
if (opened !== nonce) throw new Error('DPAPI maintenance nonce round-trip failed')
let bindingRejected = false
try {
  await unprotectMaintenanceNonce(
    protectedNonce.value,
    protectedNonce.protection,
    { ...binding, generation: binding.generation + 1 },
  )
} catch {
  bindingRejected = true
}
if (!bindingRejected) throw new Error('DPAPI optional entropy did not reject a changed binding')
process.stdout.write(`${JSON.stringify({
  protection: protectedNonce.protection,
  roundTrip: true,
  bindingRejected,
}, undefined, 2)}\n`)
