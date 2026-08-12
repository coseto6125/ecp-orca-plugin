import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Orca plugin worker for ecp.
 *
 * The worker owns one job: keep the graph warm. It spawns ecp itself, which it
 * may do because `main` is consented as trusted Node code, and it only does so
 * for a worktree path that resolves on this machine.
 *
 * It deliberately owns no configuration. This Orca build has no editor for
 * plugin-defined settings (`settings.get`/`settings.set` is a private key-value
 * store with no UI), so a knob read here would be a knob nobody can turn. What
 * needs a choice lives in the panel, where a person makes it.
 *
 * Every command sends its text without pressing Enter. `workspace.readContext`
 * returns terminal ids with no type, so neither the worker nor the panel can
 * prove a target is a shell rather than an agent's prompt; the line lands where
 * the person can read it and decide.
 */

const INDEX_CACHE_KEY = 'indexedWorktrees'
const INDEX_CACHE_LIMIT = 64
const INDEX_TTL_MS = 6 * 60 * 60 * 1000
const INDEX_TIMEOUT_MS = 4 * 60 * 1000
const PROBE_TIMEOUT_MS = 30 * 1000
const NOTIFICATION_BODY_LIMIT = 900
const TERMINAL_TEXT_LIMIT = 4096

/**
 * Two running indexes saturate the disk already, and the host SIGKILLs a worker
 * holding 64 pending events. Bounding the queue keeps a bulk worktree import
 * well under that ceiling: anything past the queue acks immediately.
 */
const MAX_CONCURRENT_INDEXES = 2
const MAX_QUEUED_INDEXES = 8

const runningChildren = new Set()

/**
 * Test seam. The host forks the worker with a fixed environment allowlist
 * (PATH, HOME, locale, temp dirs), so this variable cannot reach a real worker
 * and the name is always `ecp` in production.
 */
const ECP = process.env.ECP_BINARY ?? 'ecp'

export default async function activate(context) {
  const ecp = new EcpPlugin(context)
  context.commands.register('index-worktree', () => ecp.sendToTerminal('ecp admin index --repo .'))
  context.commands.register('impact-baseline', () => ecp.sendToTerminal('ecp impact --baseline origin/HEAD'))
  context.commands.register('summary', () => ecp.sendToTerminal('ecp summary'))
  context.events.on('worktree.created', (payload) => ecp.onWorktreeCreated(payload))
  context.events.on('worktree.removed', (payload) => ecp.onWorktreeRemoved(payload))
}

/** Host contract: called before the worker exits, so orphaned indexes stop here. */
export function deactivate() {
  for (const child of runningChildren) child.kill('SIGTERM')
  runningChildren.clear()
}

class EcpPlugin {
  constructor(context) {
    this.host = context.host
    this.log = context.log
    this.granted = new Set(
      (context.grantedCapabilities ?? []).map((capability) =>
        typeof capability === 'string' ? capability : capability.kind
      )
    )
    this.binaries = new Map()
    this.activeIndexes = 0
    this.queuedIndexes = 0
    this.waiters = []
  }

  async call(method, params, capability) {
    if (!this.granted.has(capability)) throw new Error(`${method} needs the ${capability} capability`)
    return this.host.call(method, params)
  }

  async notify(title, body) {
    try {
      await this.call(
        'notifications.show',
        { title, body: body === undefined ? undefined : body.slice(0, NOTIFICATION_BODY_LIMIT) },
        'notifications:show'
      )
    } catch (error) {
      this.log(`${title}: ${body ?? ''} (${message(error)})`)
    }
  }

  /* ---------------------------------------------------------------- events */

  async onWorktreeCreated(payload) {
    const plan = execPlan(payload.path)
    if (!plan) return this.log(`${payload.path} is not a repository this machine can index`)
    if (await this.isFresh(payload.path)) return
    if (this.queuedIndexes >= MAX_QUEUED_INDEXES) {
      return this.log(`index queue is full; skipping ${payload.path}`)
    }
    await this.enqueue(() => this.index(plan, payload))
  }

  async onWorktreeRemoved(payload) {
    const cache = await this.readCache()
    const key = cacheKey(payload.path)
    if (!(key in cache)) return
    delete cache[key]
    await this.writeCache(cache)
  }

  /* --------------------------------------------------------------- indexing */

  /** Counting semaphore, FIFO. Callers past MAX_QUEUED_INDEXES never get here. */
  async enqueue(job) {
    this.queuedIndexes += 1
    await this.acquire()
    this.queuedIndexes -= 1
    try {
      await job()
    } finally {
      this.release()
    }
  }

  acquire() {
    if (this.activeIndexes < MAX_CONCURRENT_INDEXES) {
      this.activeIndexes += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  release() {
    const next = this.waiters.shift()
    if (next) next()
    else this.activeIndexes -= 1
  }

  async index(plan, payload) {
    const prefix = await this.resolveBinary(plan)
    if (!prefix) {
      return this.notify('ecp not found', `Install ecp on ${plan.where}, then reopen this worktree.`)
    }
    try {
      await runCommand(plan.command, [...prefix, 'admin', 'index', '--repo', plan.repo], INDEX_TIMEOUT_MS)
      await this.markFresh(payload.path)
      await this.notify('ecp index ready', `${payload.branch || payload.path} is indexed.`)
    } catch (error) {
      await this.notify('ecp index failed', message(error))
    }
  }

  /**
   * `wsl.exe -- ecp` runs without a login shell, so a non-root install under
   * ~/.local/bin is off PATH there while it works fine in a terminal. Resolve
   * the absolute path once per distro through a login shell, then keep argv
   * split so paths with spaces stay one token.
   */
  async resolveBinary(plan) {
    if (!plan.distro) return []
    if (this.binaries.has(plan.distro)) return this.binaries.get(plan.distro)
    let resolved = null
    try {
      const output = await runCommand(
        plan.command,
        ['-d', plan.distro, '--', 'bash', '-lc', `command -v ${ECP}`],
        PROBE_TIMEOUT_MS
      )
      const path = output.split('\n').map((line) => line.trim()).filter(Boolean)[0]
      resolved = path ? ['-d', plan.distro, '--', path] : null
    } catch (error) {
      this.log(`ecp lookup failed in ${plan.distro}: ${message(error)}`)
    }
    this.binaries.set(plan.distro, resolved)
    return resolved
  }

  /* -------------------------------------------------------------- terminals */

  async sendToTerminal(text) {
    if (text.length > TERMINAL_TEXT_LIMIT) return { sent: false, reason: 'too long' }
    const context = await this.call('workspace.readContext', {}, 'workspace:read')
    const terminal = context?.terminals?.[0]
    if (!terminal) {
      await this.notify('ecp', 'This worktree has no terminal to type into.')
      return { sent: false, reason: 'no terminal' }
    }
    const result = await this.call(
      'terminal.sendText',
      { terminalId: terminal.id, text, enter: false },
      'terminal:send'
    )
    return { sent: result?.accepted === true, text }
  }

  /* ----------------------------------------------------------- index cache */

  async readCache() {
    try {
      const result = await this.call('storage.get', { key: INDEX_CACHE_KEY }, 'storage')
      const value = result?.value
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch {
      return {}
    }
  }

  async writeCache(cache) {
    try {
      await this.call('storage.set', { key: INDEX_CACHE_KEY, value: cache }, 'storage')
    } catch (error) {
      this.log(`index cache write failed: ${message(error)}`)
    }
  }

  async isFresh(path) {
    const stamp = (await this.readCache())[cacheKey(path)]
    return typeof stamp === 'number' && Date.now() - stamp < INDEX_TTL_MS
  }

  async markFresh(path) {
    const cache = await this.readCache()
    cache[cacheKey(path)] = Date.now()
    await this.writeCache(prune(cache))
  }
}

/**
 * Plugins run on the Orca client machine even when the worktree does not, so a
 * path is only executable here when it resolves on this filesystem. The one
 * exception worth carrying is Windows plus WSL, where the UNC form names the
 * distro and the rest of the path is already the Linux path.
 *
 * Requiring a `.git` entry is a weak check on purpose: the event payload
 * carries no host identity, so an SSH worktree whose path also exists locally
 * is indistinguishable from a local one. The check rejects the common accident,
 * not the deliberate collision.
 */
export function execPlan(path) {
  const wsl = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\(.*)$/i.exec(path)
  if (wsl) {
    return {
      command: 'wsl.exe',
      distro: wsl[1],
      repo: `/${wsl[2].replace(/\\/g, '/')}`,
      where: wsl[1]
    }
  }
  if (!existsSync(join(path, '.git'))) return null
  return { command: ECP, distro: null, repo: path, where: 'this machine' }
}

/** Keeps the stored value small and bounded, whatever the paths look like. */
export function cacheKey(path) {
  return createHash('sha256').update(path).digest('hex').slice(0, 16)
}

function prune(cache) {
  const entries = Object.entries(cache).sort(([, a], [, b]) => b - a)
  return Object.fromEntries(entries.slice(0, INDEX_CACHE_LIMIT))
}

function runCommand(command, args, timeout) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      runningChildren.delete(child)
      if (error) reject(new Error(`${command} ${args.join(' ')}: ${stderr || error.message}`))
      else resolve(stdout)
    })
    runningChildren.add(child)
  })
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}
