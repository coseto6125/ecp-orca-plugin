import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import activate, { execPlan } from '../worker/main.mjs'

function fakeContext({ settings = {}, terminals = [{ id: 'term-1' }], branch = 'feat/x' } = {}) {
  const calls = []
  const storage = new Map()
  const context = {
    calls,
    commands: { handlers: new Map(), register(id, handler) { this.handlers.set(id, handler) } },
    events: { handlers: new Map(), on(event, handler) { this.handlers.set(event, handler) } },
    grantedCapabilities: [
      { kind: 'workspace:read' }, { kind: 'terminal:send' }, { kind: 'notifications:show' },
      { kind: 'storage' }, { kind: 'events:subscribe' }, { kind: 'settings:own' }
    ],
    log() {},
    host: {
      async call(method, params) {
        calls.push({ method, params })
        switch (method) {
          case 'settings.get': return { settings }
          case 'workspace.readContext': return { branch, displayName: 'repo', terminals }
          case 'terminal.sendText': return { accepted: true }
          case 'notifications.show': return { delivered: true }
          case 'storage.get': return { value: storage.get(params.key) ?? null }
          case 'storage.set': storage.set(params.key, params.value); return { ok: true }
          default: throw new Error(`unexpected host method ${method}`)
        }
      }
    }
  }
  return context
}

test('activate registers every contributed command and event', async () => {
  const context = fakeContext()
  await activate(context)
  assert.deepEqual(
    [...context.commands.handlers.keys()].sort(),
    ['doctor', 'impact-baseline', 'index-worktree', 'install-cli']
  )
  assert.deepEqual([...context.events.handlers.keys()].sort(), ['worktree.created', 'worktree.removed'])
})

test('impact command sends the configured baseline to the selected terminal', async () => {
  const context = fakeContext({
    settings: { baseline: 'origin/develop', terminalIndex: 1 },
    terminals: [{ id: 'agent-pane' }, { id: 'shell' }]
  })
  await activate(context)
  const result = await context.commands.handlers.get('impact-baseline')()
  assert.deepEqual(result, { sent: true, text: 'ecp impact --baseline origin/develop' })
  const sent = context.calls.find((call) => call.method === 'terminal.sendText')
  assert.equal(sent.params.terminalId, 'shell')
  assert.equal(sent.params.enter, true)
})

test('commands report instead of throwing when the terminal index is out of range', async () => {
  const context = fakeContext({ settings: { terminalIndex: 3 } })
  await activate(context)
  assert.deepEqual(await context.commands.handlers.get('doctor')(), { sent: false })
  assert.ok(context.calls.some((call) => call.method === 'notifications.show'))
})

test('autoIndex false stops the worktree.created handler before it spawns anything', async () => {
  const context = fakeContext({ settings: { autoIndex: false } })
  await activate(context)
  await context.events.handlers.get('worktree.created')({ worktreeId: 'w1', path: '/nope', branch: 'main' })
  assert.deepEqual(context.calls.map((call) => call.method), ['settings.get'])
})

test('worktree.removed drops only its own cache entry', async () => {
  const context = fakeContext()
  await activate(context)
  const created = mkdtempSync(`${tmpdir()}/ecp-orca-`)
  await context.host.call('storage.set', { key: 'indexedWorktrees', value: { [created]: 1, '/other': 2 } })
  await context.events.handlers.get('worktree.removed')({ worktreeId: 'w1', path: created })
  const { value } = await context.host.call('storage.get', { key: 'indexedWorktrees' })
  assert.deepEqual(value, { '/other': 2 })
})

test('execPlan routes a Windows UNC path through the WSL distro it names', () => {
  const plan = execPlan('\\\\wsl.localhost\\Ubuntu\\home\\enor\\code-graph-nexus')
  assert.deepEqual(plan, {
    command: 'wsl.exe',
    prefix: ['-d', 'Ubuntu', '--', 'ecp'],
    repo: '/home/enor/code-graph-nexus'
  })
})

test('execPlan honours the ecpPath and wslDistro settings', () => {
  const plan = execPlan('\\\\wsl$\\Debian\\srv\\app', { ecpPath: '/opt/ecp', wslDistro: 'Ubuntu-24.04' })
  assert.deepEqual(plan.prefix, ['-d', 'Ubuntu-24.04', '--', '/opt/ecp'])
  assert.equal(plan.repo, '/srv/app')
})

test('execPlan runs a path that exists on this filesystem directly', () => {
  const local = mkdtempSync(`${tmpdir()}/ecp-orca-`)
  assert.deepEqual(execPlan(local), { command: 'ecp', prefix: [], repo: local })
})

test('execPlan refuses a path this machine cannot see, such as an SSH workspace', () => {
  assert.equal(execPlan('/remote/host/only/repo'), null)
})
