import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Locates the shared plugin modules of the Orca build installed on this machine. */

const CANDIDATE_ROOTS = [
  '/mnt/c/Users/%USER%/AppData/Local/Programs/orca/resources',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Programs/orca/resources`,
  '/Applications/Orca.app/Contents/Resources',
  `${process.env.HOME}/.local/share/orca/resources`
].filter(Boolean)

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
export const orcaRequire = createRequire(import.meta.url)

export function orcaResources() {
  if (process.env.ORCA_RESOURCES) return process.env.ORCA_RESOURCES
  for (const candidate of CANDIDATE_ROOTS) {
    for (const path of expandUser(candidate)) {
      if (existsSync(join(path, 'app.asar.unpacked/out/shared/plugins/plugin-manifest.js'))) return path
    }
  }
  return null
}

export function sharedPlugins(resources) {
  return join(resources, 'app.asar.unpacked/out/shared/plugins')
}

export function hostEntry(resources) {
  return join(resources, 'app.asar.unpacked/out/main/plugin-host-entry.js')
}

function expandUser(candidate) {
  if (!candidate.includes('%USER%')) return [candidate]
  const users = '/mnt/c/Users'
  if (!existsSync(users)) return []
  return readdirSync(users).map((user) => candidate.replace('%USER%', user))
}
