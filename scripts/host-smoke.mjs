import { fork } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { orcaRequire, orcaResources, repoRoot, sharedPlugins, hostEntry } from './orca.mjs'

/**
 * Runs worker/main.mjs under Orca's own worker runtime: the real
 * plugin-host-entry.js, the real IPC protocol, and the real host-API schemas
 * gating every call. A fake host object cannot catch a worker that sends
 * params the host would reject; this can.
 */

const resources = orcaResources()
if (!resources) {
  console.error('no installed Orca found; set ORCA_RESOURCES to the app resources directory')
  process.exit(2)
}

const modules = sharedPlugins(resources)
const { PLUGIN_HOST_API_V0, getPluginHostMethodSpec } = orcaRequire(join(modules, 'plugin-host-api.js'))
const { pluginWorkerChildMessageSchema } = orcaRequire(join(modules, 'plugin-host-protocol.js'))
const { pluginManifestSchema } = orcaRequire(join(modules, 'plugin-manifest.js'))
const { PLUGIN_EVENT_PAYLOAD_SCHEMAS } = orcaRequire(join(modules, 'plugin-events.js'))

const manifest = pluginManifestSchema.parse(JSON.parse(readFileSync(join(repoRoot, 'orca-plugin.json'), 'utf8')))
const granted = manifest.capabilities.map((capability) => capability.kind)

const workspace = mkdtempSync(join(tmpdir(), 'ecp-orca-smoke-'))
const marker = join(workspace, 'ecp-invocations.log')
const stubEcp = join(workspace, 'ecp-stub.sh')
writeFileSync(stubEcp, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(marker)}\n`)
chmodSync(stubEcp, 0o755)

const hostCalls = []
const notifications = []
const storage = new Map()
const terminals = [{ id: 'agent-pane' }, { id: 'shell' }]

const child = fork(hostEntry(resources), [], {
  execArgv: [],
  serialization: 'advanced',
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  // A real host forks with a fixed allowlist that cannot carry ECP_BINARY; the
  // smoke sets it so the worker spawns a stub instead of the machine's ecp.
  env: { PATH: process.env.PATH, HOME: process.env.HOME, ECP_BINARY: stubEcp }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (line) => console.error(`[worker stderr] ${line.trim()}`))

const pending = new Map()
let nextCallId = 0
let nextEventId = 0
let ready = null
const readyPromise = new Promise((resolve) => { ready = resolve })

child.on('message', async (raw) => {
  const parsed = pluginWorkerChildMessageSchema.safeParse(raw)
  assert.ok(parsed.success, `worker sent a message the host would reject: ${JSON.stringify(raw)}`)
  const message = parsed.data
  switch (message.type) {
    case 'ready': return ready(message.commands)
    case 'log': return console.log(`[worker ${message.level}] ${message.message}`)
    case 'fatal': throw new Error(`worker fatal: ${message.error}`)
    case 'commandResult':
    case 'eventAck': {
      const key = message.type === 'eventAck' ? `event:${message.eventId}` : `call:${message.callId}`
      pending.get(key)?.(message)
      pending.delete(key)
      return
    }
    case 'hostCall': return child.send(await handleHostCall(message))
  }
})

/** Mirrors the host gate: unknown method, missing capability, bad params, all rejected. */
async function handleHostCall({ callId, method, params }) {
  const spec = getPluginHostMethodSpec(method)
  if (!spec) return { type: 'hostResult', callId, ok: false, error: `unknown method ${method}` }
  if (!granted.includes(spec.capability)) {
    return { type: 'hostResult', callId, ok: false, error: `missing capability ${spec.capability}` }
  }
  const parsedParams = spec.params.safeParse(params)
  if (!parsedParams.success) {
    return { type: 'hostResult', callId, ok: false, error: JSON.stringify(parsedParams.error.issues) }
  }
  hostCalls.push({ method, params: parsedParams.data })
  const value = respond(method, parsedParams.data)
  const parsedResult = spec.result.safeParse(value)
  assert.ok(parsedResult.success, `smoke host produced a ${method} result the schema rejects`)
  return { type: 'hostResult', callId, ok: true, value: parsedResult.data }
}

function respond(method, params) {
  switch (method) {
    case 'workspace.readContext': return { branch: 'feat/x', displayName: 'ecp-orca-plugin', terminals }
    case 'terminal.sendText': return { accepted: true }
    case 'notifications.show': notifications.push(params); return { delivered: true }
    case 'storage.get': return { value: storage.get(params.key) ?? null }
    case 'storage.set': storage.set(params.key, params.value); return { ok: true }
    case 'storage.delete': storage.delete(params.key); return { ok: true }
    default: throw new Error(`smoke host has no response for ${method}`)
  }
}

function invokeCommand(commandId) {
  const callId = nextCallId++
  return new Promise((resolve) => {
    pending.set(`call:${callId}`, resolve)
    child.send({ type: 'invokeCommand', callId, commandId })
  })
}

function deliverEvent(event, payload) {
  PLUGIN_EVENT_PAYLOAD_SCHEMAS[event].parse(payload)
  const eventId = nextEventId++
  return new Promise((resolve) => {
    pending.set(`event:${eventId}`, resolve)
    child.send({ type: 'deliverEvent', eventId, event, payload })
  })
}

child.send({
  type: 'init',
  pluginId: `${manifest.publisher}.${manifest.id}`,
  pluginRoot: repoRoot,
  mainEntry: manifest.main,
  grantedCapabilities: granted
})

const registered = await readyPromise
const workerCommands = manifest.contributes.commands.filter((command) => command.action === undefined)
assert.deepEqual(registered.sort(), workerCommands.map((command) => command.id).sort())
console.log(`ok  ready with ${registered.length} commands`)

const doctor = await invokeCommand('doctor')
assert.equal(doctor.ok, true, doctor.error)
assert.deepEqual(doctor.value, { sent: true, text: 'ecp doctor' })
const sent = hostCalls.filter((call) => call.method === 'terminal.sendText').at(-1)
assert.equal(sent.params.enter, false, 'a blind terminal target must not execute the line')
console.log(`ok  doctor typed ${JSON.stringify(sent.params.text)} into ${sent.params.terminalId} without Enter`)

const impact = await invokeCommand('impact-baseline')
assert.deepEqual(impact.value, { sent: true, text: 'ecp impact --baseline origin/HEAD' })
console.log('ok  impact sent a ref no panel input could have injected into')

mkdirSync(join(workspace, '.git'))
const created = { worktreeId: 'w-1', path: workspace, branch: 'feat/x' }
await deliverEvent('worktree.created', created)
assert.ok(existsSync(marker), 'auto-index never spawned the ecp executable')
assert.equal(readFileSync(marker, 'utf8').trim(), `admin index --repo ${workspace}`)
assert.ok(notifications.some((notification) => notification.title === 'ecp index ready'))
console.log(`ok  worktree.created spawned: ${readFileSync(marker, 'utf8').trim()}`)

await deliverEvent('worktree.created', created)
assert.equal(readFileSync(marker, 'utf8').trim().split('\n').length, 1, 'index cache did not suppress the rerun')
console.log('ok  second worktree.created was suppressed by the index cache')

await deliverEvent('worktree.removed', { worktreeId: 'w-1', path: workspace })
assert.deepEqual(storage.get('indexedWorktrees'), {})
console.log('ok  worktree.removed cleared the cache entry')

child.send({ type: 'shutdown' })
child.on('exit', (code) => {
  console.log(`ok  worker exited with code ${code}`)
  process.exit(0)
})
