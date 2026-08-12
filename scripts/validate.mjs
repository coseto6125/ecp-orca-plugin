import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { orcaRequire, orcaResources, repoRoot, sharedPlugins } from './orca.mjs'

/**
 * Validates both JSON files against the schemas of the Orca build installed on
 * this machine, so a manifest mistake surfaces here instead of at install time.
 */

const resources = orcaResources()
if (!resources) {
  console.error('no installed Orca found; set ORCA_RESOURCES to the app resources directory')
  process.exit(2)
}

const modules = sharedPlugins(resources)
const manifestModule = orcaRequire(join(modules, 'plugin-manifest.js'))
const marketplaceModule = orcaRequire(join(modules, 'plugin-marketplace.js'))

let failed = false
const manifest = check('orca-plugin.json', manifestModule.pluginManifestSchema)
const marketplace = check('orca-marketplace.json', marketplaceModule.pluginMarketplaceSchema)

if (manifest && marketplace) {
  const key = `${manifest.publisher}.${manifest.id}`
  if (!marketplace.plugins.some((plugin) => plugin.id === key)) fail(`orca-marketplace.json does not list ${key}`)
  if (marketplaceModule.isReservedPluginIdentity(key)) fail(`${key} uses a reserved identity`)
  for (const plugin of marketplace.plugins) {
    if (!marketplaceModule.isMarketplaceListingSupported(plugin.categories)) {
      fail(`${plugin.id} uses a category this Orca build hides`)
    }
  }
  for (const artifact of [manifest.main, ...manifest.contributes.panels.map((panel) => panel.entry)]) {
    if (artifact && !existsSync(join(repoRoot, artifact))) fail(`declared artifact missing: ${artifact}`)
  }
}

console.log(failed ? 'FAIL' : `ok — validated against ${modules}`)
process.exit(failed ? 1 : 0)

function check(file, schema) {
  const result = schema.safeParse(JSON.parse(readFileSync(join(repoRoot, file), 'utf8')))
  if (result.success) return result.data
  for (const issue of result.error.issues) fail(`${file}: ${issue.path.join('.')}: ${issue.message}`)
  return null
}

function fail(line) {
  failed = true
  console.error(line)
}
