import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * Orca plugin worker for ecp.
 *
 * Two transports, picked per job:
 *
 *   exec      the worker is trusted Node, so it can spawn ecp itself. Used for
 *             work with no output worth reading (keeping the index warm). Needs
 *             a worktree path, which only arrives on `worktree.created`.
 *   terminal  host API `terminal.sendText`. Used for every command whose output
 *             the human or the agent must see, because a worker can only report
 *             through a 1000-char notification.
 */

const INDEX_CACHE_KEY = 'indexedWorktrees'
const INDEX_TTL_MS = 6 * 60 * 60 * 1000
const INDEX_TIMEOUT_MS = 4 * 60 * 1000
const INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/coseto6125/egent-code-plexus/main/install.sh | bash'

export default async function activate(context) {
  const ecp = new EcpPlugin(context)
  context.commands.register('index-worktree', () => ecp.indexFocusedWorktree())
  context.commands.register('impact-baseline', () => ecp.impactAgainstBaseline())
  context.commands.register('doctor', () => ecp.doctor())
  context.commands.register('install-cli', () => ecp.installCli())
  context.events.on('worktree.created', (payload) => ecp.onWorktreeCreated(payload))
  context.events.on('worktree.removed', (payload) => ecp.onWorktreeRemoved(payload))
}

class EcpPlugin {
  constructor(context) {
    this.host = context.host
    this.log = context.log
    this.granted = new Set((context.grantedCapabilities ?? []).map((capability) => capability.kind ?? capability))
  }

  has(capability) {
    return this.granted.size === 0 || this.granted.has(capability)
  }

  async call(method, params, capability) {
    if (!this.has(capability)) throw new Error(`${method} needs the ${capability} capability`)
    return this.host.call(method, params)
  }

  async settings() {
    try {
      const result = await this.call('settings.get', {}, 'settings:own')
      return result?.settings ?? {}
    } catch (error) {
      this.log(`settings unavailable: ${message(error)}`)
      return {}
    }
  }

  async notify(title, body) {
    try {
      await this.call('notifications.show', { title, body }, 'notifications:show')
    } catch (error) {
      this.log(`${title}: ${body ?? ''} (${message(error)})`)
    }
  }

  /* ---------------------------------------------------------------- events */

  async onWorktreeCreated(payload) {
    const settings = await this.settings()
    if (settings.autoIndex === false) return
    const plan = execPlan(payload.path, settings)
    if (!plan) {
      this.log(`no local ecp for ${payload.path}; skipping auto-index`)
      return
    }
    if (await this.isFresh(payload.path)) return
    try {
      await runCommand(plan.command, [...plan.prefix, 'admin', 'index', '--repo', plan.repo], INDEX_TIMEOUT_MS)
      await this.markFresh(payload.path)
      await this.notify('ecp index ready', `${payload.branch || payload.path} is indexed.`)
    } catch (error) {
      await this.notify('ecp index failed', message(error).slice(0, 900))
    }
  }

  async onWorktreeRemoved(payload) {
    const cache = await this.readCache()
    if (!(payload.path in cache)) return
    delete cache[payload.path]
    await this.writeCache(cache)
  }

  /* -------------------------------------------------------------- commands */

  async indexFocusedWorktree() {
    return this.sendToTerminal('ecp admin index --repo .')
  }

  async impactAgainstBaseline() {
    const settings = await this.settings()
    const baseline = typeof settings.baseline === 'string' && settings.baseline ? settings.baseline : 'origin/main'
    return this.sendToTerminal(`ecp impact --baseline ${baseline}`)
  }

  async doctor() {
    return this.sendToTerminal('ecp doctor')
  }

  async installCli() {
    return this.sendToTerminal(INSTALL_COMMAND)
  }

  /**
   * The host has no "active terminal" write target on purpose, so a terminal is
   * addressed by id. `workspace.readContext` does not say which id is a shell
   * and which is an agent TUI, so the index is a setting the user can correct.
   */
  async sendToTerminal(text) {
    const context = await this.call('workspace.readContext', {}, 'workspace:read')
    if (!context) {
      await this.notify('ecp', 'No focused worktree.')
      return { sent: false }
    }
    const settings = await this.settings()
    const index = Number.isInteger(settings.terminalIndex) ? settings.terminalIndex : 0
    const terminal = context.terminals[index]
    if (!terminal) {
      await this.notify('ecp', `Worktree ${context.displayName} has no terminal at index ${index}.`)
      return { sent: false }
    }
    const result = await this.call(
      'terminal.sendText',
      { terminalId: terminal.id, text, enter: settings.terminalEnter !== false },
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
    const stamp = (await this.readCache())[path]
    return typeof stamp === 'number' && Date.now() - stamp < INDEX_TTL_MS
  }

  async markFresh(path) {
    const cache = await this.readCache()
    cache[path] = Date.now()
    await this.writeCache(cache)
  }
}

/**
 * Plugins run on the Orca client machine even when the worktree does not, so a
 * path is only executable here when it resolves on this filesystem. The one
 * exception worth carrying is Windows plus WSL, where the UNC form names the
 * distro and the rest of the path is already the Linux path.
 */
export function execPlan(path, settings = {}) {
  const ecp = typeof settings.ecpPath === 'string' && settings.ecpPath ? settings.ecpPath : 'ecp'
  const wsl = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\(.*)$/.exec(path)
  if (wsl) {
    const distro = settings.wslDistro || wsl[1]
    return { command: 'wsl.exe', prefix: ['-d', distro, '--', ecp], repo: `/${wsl[2].replace(/\\/g, '/')}` }
  }
  if (!existsSync(path)) return null
  return { command: ecp, prefix: [], repo: path }
}

function runCommand(command, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args.join(' ')}: ${stderr || error.message}`))
      else resolve(stdout)
    })
  })
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}
