import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const pythonRoot = fileURLToPath(new URL('../python/', import.meta.url))
const executable = process.env.PYTHON?.trim() || 'python'
const child = spawn(executable, ['-u', '-m', 'georesearch_worker'], {
  cwd: pythonRoot,
  env: { ...process.env, PYTHONPATH: pythonRoot },
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
})
const lines = createInterface({ input: child.stdout })
const queue: unknown[] = []
const waiters: Array<(value: unknown) => void> = []
lines.on('line', line => {
  const value = JSON.parse(line) as unknown
  const waiter = waiters.shift()
  if (waiter === undefined) queue.push(value)
  else waiter(value)
})
let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => { stderr += String(chunk) })

const hello = await nextLine()
assertRecord(hello, 'hello')
assertHello(hello)
child.stdin.write(`${JSON.stringify({
  id: 'expired-1',
  method: 'ping',
  deadline: new Date(Date.now() - 1000).toISOString(),
  params: {},
})}\n`)
const expired = await nextLine()
assertRecord(expired, 'expired deadline')
if (expired.id !== 'expired-1' || expired.error !== 'DEADLINE_EXCEEDED') {
  throw new Error(`worker deadline contract failed: ${JSON.stringify(expired)}`)
}
child.stdin.write(`${JSON.stringify({
  id: 'sleep-1',
  method: 'sleep',
  deadline: new Date(Date.now() + 30_000).toISOString(),
  params: { milliseconds: 10_000 },
})}\n`)
child.stdin.write(`${JSON.stringify({ type: 'cancel', id: 'sleep-1' })}\n`)
const cancellation = await nextLine()
assertRecord(cancellation, 'cancellation')
if (cancellation.id !== 'sleep-1' || cancellation.error !== 'CANCELLED') {
  throw new Error(`worker cancel contract failed: ${JSON.stringify(cancellation)}`)
}
child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
child.stdin.end()
const exitCode = await new Promise<number>((resolve, reject) => {
  child.once('error', reject)
  child.once('close', code => resolve(code ?? 1))
})
if (exitCode !== 0) throw new Error(`worker exited ${exitCode}: ${stderr}`)
process.stdout.write(`${JSON.stringify({
  hello: true,
  deadline: true,
  cancellation: true,
  exitCode,
}, undefined, 2)}\n`)

async function nextLine(): Promise<any> {
  if (queue.length > 0) return queue.shift()
  return await Promise.race([
    new Promise(resolve => waiters.push(resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('worker probe timed out')), 5000)),
  ])
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, any> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`)
  }
}

function assertHello(hello: Record<string, any>): void {
  const capabilities = hello.capabilities
  assertRecord(capabilities, 'hello capabilities')
  if (hello.type !== 'hello'
    || hello.protocol !== 'georesearch-worker/1'
    || hello.workerVersion !== '0.1.0'
    || typeof hello.pythonVersion !== 'string'
    || hello.pythonVersion.length === 0
    || !Array.isArray(capabilities.methods)
    || !capabilities.methods.includes('ping')
    || !capabilities.methods.includes('sleep')
    || capabilities.cancel !== true
    || capabilities.deadlines !== true) {
    throw new Error(`worker hello contract failed: ${JSON.stringify(hello)}`)
  }
}
