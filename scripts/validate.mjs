import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Validates both JSON files against the schemas of the Orca build installed on
 * this machine, so a manifest mistake surfaces here instead of at install time.
 */

const CANDIDATE_ROOTS = [
  '/mnt/c/Users/%USER%/AppData/Local/Programs/orca/resources/app.asar.unpacked/out/shared/plugins',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Programs/orca/resources/app.asar.unpacked/out/shared/plugins`,
  '/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/shared/plugins',
  `${process.env.HOME}/.local/share/orca/resources/app.asar.unpacked/out/shared/plugins`
].filter(Boolean)

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const require_ = createRequire(import.meta.url)

const root = resolveOrcaPluginModules()
if (!root) {
  console.error('no installed Orca found; set ORCA_PLUGIN_MODULES to <resources>/app.asar.unpacked/out/shared/plugins')
  process.exit(2)
}

const manifestModule = require_(join(root, 'plugin-manifest.js'))
const marketplaceModule = require_(join(root, 'plugin-marketplace.js'))

let failed = false
const manifest = check('orca-plugin.json', manifestModule.pluginManifestSchema)
const marketplace = check('orca-marketplace.json', marketplaceModule.pluginMarketplaceSchema)

if (manifest && marketplace) {
  const key = `${manifest.publisher}.${manifest.id}`
  const listed = marketplace.plugins.find((plugin) => plugin.id === key)
  if (!listed) fail(`orca-marketplace.json does not list ${key}`)
  if (marketplaceModule.isReservedPluginIdentity(key)) fail(`${key} uses a reserved identity`)
  for (const plugin of marketplace.plugins) {
    if (!marketplaceModule.isMarketplaceListingSupported(plugin.categories)) {
      fail(`${plugin.id} uses a category this Orca build hides`)
    }
  }
  for (const artifact of [manifest.main, ...manifest.contributes.panels.map((panel) => panel.entry)]) {
    if (artifact && !existsSync(join(repo, artifact))) fail(`declared artifact missing: ${artifact}`)
  }
}

console.log(failed ? 'FAIL' : `ok — validated against ${root}`)
process.exit(failed ? 1 : 0)

function check(file, schema) {
  const result = schema.safeParse(JSON.parse(readFileSync(join(repo, file), 'utf8')))
  if (result.success) return result.data
  for (const issue of result.error.issues) fail(`${file}: ${issue.path.join('.')}: ${issue.message}`)
  return null
}

function fail(line) {
  failed = true
  console.error(line)
}

function resolveOrcaPluginModules() {
  if (process.env.ORCA_PLUGIN_MODULES) return process.env.ORCA_PLUGIN_MODULES
  for (const candidate of CANDIDATE_ROOTS) {
    for (const path of expandUser(candidate)) if (existsSync(path)) return path
  }
  return null
}

function expandUser(candidate) {
  if (!candidate.includes('%USER%')) return [candidate]
  const users = '/mnt/c/Users'
  if (!existsSync(users)) return []
  return require_('node:fs')
    .readdirSync(users)
    .map((user) => candidate.replace('%USER%', user))
}
