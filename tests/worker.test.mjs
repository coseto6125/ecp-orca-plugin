import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The worker resolves its executable once at load, so the stub has to exist and
 * be named before the import. A real worker never sees ECP_BINARY: the host
 * forks it with a fixed environment allowlist.
 */
const stubDir = mkdtempSync(join(tmpdir(), 'ecp-orca-stub-'))
const stubLog = join(stubDir, 'runs.log')
const stub = join(stubDir, 'ecp-stub.sh')
writeFileSync(stub, `#!/bin/sh\nprintf 'start\\n' >> ${stubLog}\nsleep 0.2\nprintf 'end\\n' >> ${stubLog}\n`)
chmodSync(stub, 0o755)
process.env.ECP_BINARY = stub

const { default: activate, deactivate, execPlan, cacheKey } = await import('../worker/main.mjs')

/**
 * The fake host mirrors the real one where the real one can bite: capabilities
 * arrive as strings, storage round-trips through a structured clone, and an
 * ungranted capability is refused. What it cannot show is listed in README.
 */
function fakeContext({ terminals = [{ id: 'term-1' }], capabilities } = {}) {
  const calls = []
  const logs = []
  const storage = new Map()
  const granted = capabilities ?? [
    'workspace:read', 'terminal:send', 'notifications:show', 'storage', 'events:subscribe'
  ]
  return {
    calls,
    logs,
    commands: { handlers: new Map(), register(id, handler) { this.handlers.set(id, handler) } },
    events: { handlers: new Map(), on(event, handler) { this.handlers.set(event, handler) } },
    grantedCapabilities: granted,
    // The real host passes a plain function, so the worker may call it unbound.
    log: (line) => logs.push(line),
    host: {
      async call(method, params) {
        calls.push({ method, params })
        switch (method) {
          case 'workspace.readContext': return { branch: 'feat/x', displayName: 'repo', terminals }
          case 'terminal.sendText': return { accepted: true }
          case 'notifications.show': return { delivered: true }
          case 'storage.get': return { value: structuredClone(storage.get(params.key) ?? null) }
          case 'storage.set': storage.set(params.key, structuredClone(params.value)); return { ok: true }
          default: throw new Error(`unexpected host method ${method}`)
        }
      }
    }
  }
}

function repoAt(prefix = 'ecp-orca-') {
  const path = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(path, '.git'))
  return path
}

test('activate registers every contributed command and event', async () => {
  const context = fakeContext()
  await activate(context)
  assert.deepEqual([...context.commands.handlers.keys()].sort(), ['impact-baseline', 'index-worktree', 'summary'])
  assert.deepEqual([...context.events.handlers.keys()].sort(), ['worktree.created', 'worktree.removed'])
})

test('commands type into a terminal without pressing Enter', async () => {
  const context = fakeContext({ terminals: [{ id: 'agent-pane' }, { id: 'shell' }] })
  await activate(context)
  const result = await context.commands.handlers.get('impact-baseline')()
  assert.deepEqual(result, { sent: true, text: 'ecp impact --baseline origin/HEAD' })
  const sent = context.calls.find((call) => call.method === 'terminal.sendText')
  assert.equal(sent.params.enter, false, 'a blind target must not execute the line')
  assert.equal(sent.params.terminalId, 'agent-pane')
})

test('a command reports instead of throwing when the worktree has no terminal', async () => {
  const context = fakeContext({ terminals: [] })
  await activate(context)
  assert.deepEqual(await context.commands.handlers.get('summary')(), { sent: false, reason: 'no terminal' })
  assert.ok(context.calls.some((call) => call.method === 'notifications.show'))
})

test('an ungranted capability fails closed rather than calling the host', async () => {
  const context = fakeContext({ capabilities: ['storage'] })
  await activate(context)
  await assert.rejects(
    () => context.commands.handlers.get('summary')(),
    /workspace.readContext needs the workspace:read capability/
  )
  assert.deepEqual(context.calls, [])
})

test('a path with no .git is not indexed', async () => {
  const context = fakeContext()
  await activate(context)
  const path = mkdtempSync(join(tmpdir(), 'ecp-orca-bare-'))
  await context.events.handlers.get('worktree.created')({ worktreeId: 'w1', path, branch: 'main' })
  assert.deepEqual(context.calls, [])
  assert.ok(context.logs.some((line) => line.includes('not a repository')))
})

test('the index queue caps concurrency and sheds the rest', async () => {
  const context = fakeContext()
  await activate(context)
  const created = context.events.handlers.get('worktree.created')
  await Promise.all(Array.from({ length: 20 }, (_, index) => created({
    worktreeId: `w${index}`,
    path: repoAt(`ecp-orca-load-${index}-`),
    branch: 'main'
  })))

  const events = readFileSync(stubLog, 'utf8').trim().split('\n')
  let running = 0
  let peak = 0
  for (const event of events) {
    running += event === 'start' ? 1 : -1
    peak = Math.max(peak, running)
  }
  const started = events.filter((event) => event === 'start').length
  const shed = context.logs.filter((line) => line.includes('index queue is full')).length

  assert.equal(peak, 2, `two indexes may run at once, saw ${peak}`)
  assert.equal(started + shed, 20, 'every event either indexed or was shed')
  assert.ok(started <= 10, `at most two running plus eight queued may start, saw ${started}`)
  assert.ok(shed > 0, 'nothing was shed, so the queue was unbounded')
})

test('worktree.removed drops only its own cache entry, keyed by digest', async () => {
  const context = fakeContext()
  await activate(context)
  const path = repoAt()
  await context.host.call('storage.set', {
    key: 'indexedWorktrees',
    value: { [cacheKey(path)]: 1, [cacheKey('/other')]: 2 }
  })
  await context.events.handlers.get('worktree.removed')({ worktreeId: 'w1', path })
  const { value } = await context.host.call('storage.get', { key: 'indexedWorktrees' })
  assert.deepEqual(value, { [cacheKey('/other')]: 2 })
})

test('deactivate is exported so the host can stop indexes before the worker exits', () => {
  assert.equal(typeof deactivate, 'function')
  assert.doesNotThrow(() => deactivate())
})

test('execPlan routes a Windows UNC path through the WSL distro it names', () => {
  assert.deepEqual(execPlan('\\\\wsl.localhost\\Ubuntu\\home\\enor\\code-graph-nexus'), {
    command: 'wsl.exe',
    distro: 'Ubuntu',
    repo: '/home/enor/code-graph-nexus',
    where: 'Ubuntu'
  })
})

test('execPlan matches the UNC prefix case-insensitively, as Windows does', () => {
  const plan = execPlan('\\\\WSL.LOCALHOST\\Ubuntu-24.04\\srv\\my app')
  assert.equal(plan.distro, 'Ubuntu-24.04')
  assert.equal(plan.repo, '/srv/my app')
})

test('execPlan runs a repository that exists on this filesystem directly', () => {
  const path = repoAt()
  assert.deepEqual(execPlan(path), { command: stub, distro: null, repo: path, where: 'this machine' })
})

test('execPlan refuses a path this machine cannot see, such as an SSH workspace', () => {
  assert.equal(execPlan('/remote/host/only/repo'), null)
})

test('cacheKey is bounded, so the stored cache cannot outgrow the host limit', () => {
  assert.match(cacheKey(`/${'x'.repeat(30000)}`), /^[0-9a-f]{16}$/)
})

test('the stub proves auto-index ran the resolved executable, not a mock', () => {
  assert.ok(existsSync(stubLog), 'no index ever spawned')
})
