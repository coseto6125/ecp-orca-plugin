import { readFileSync, realpathSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
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
  // The host resolves every declared artifact through realpath and rejects a
  // directory, a symlink out of the tree, or an oversized file. Existence alone
  // passes here and fails at install, so mirror the real checks.
  const artifacts = [
    manifest.main && { label: 'worker entry', path: manifest.main, maxBytes: 50 * 1024 * 1024 },
    ...manifest.contributes.panels.map((panel) => ({
      label: `panel "${panel.id}" entry`,
      path: panel.entry,
      maxBytes: 10 * 1024 * 1024
    }))
  ].filter(Boolean)
  const rootReal = realpathSync(repoRoot)
  for (const artifact of artifacts) {
    try {
      const real = realpathSync(resolve(repoRoot, ...artifact.path.split(/[\\/]/)))
      const fromRoot = relative(rootReal, real)
      if (!fromRoot || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
        throw new Error('resolves outside the plugin directory')
      }
      const stat = statSync(real)
      if (!stat.isFile()) throw new Error('is not a regular file')
      if (stat.size > artifact.maxBytes) throw new Error(`exceeds the ${artifact.maxBytes}-byte artifact limit`)
    } catch (error) {
      fail(`${artifact.label} ${artifact.path}: ${error.message}`)
    }
  }

  // A marketplace install resolves the listed ref to a commit before it clones,
  // so a listing that names a ref this repo has not published cannot install.
  for (const plugin of marketplace.plugins) {
    if (!refExists(plugin.source.ref)) {
      fail(`orca-marketplace.json lists ${plugin.id} at ref ${plugin.source.ref}, which this repo has no tag or branch for`)
    }
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

function refExists(ref) {
  try {
    execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
