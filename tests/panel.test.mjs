import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { orcaRequire, orcaResources, repoRoot, sharedPlugins } from '../scripts/orca.mjs'

/**
 * A panel document is served inside a sandboxed iframe under
 * `default-src 'none'; connect-src 'none'`, and may only ask the host for the
 * subset of methods marked panel-callable. Both are checked here against the
 * installed Orca, because the panel has no runtime test.
 */

const panel = readFileSync(join(repoRoot, 'panel/index.html'), 'utf8')
const resources = orcaResources()

test('the panel only requests actions the host exposes to panels', { skip: !resources && 'no installed Orca' }, () => {
  const { PLUGIN_PANEL_ACTIONS } = orcaRequire(join(sharedPlugins(resources), 'plugin-host-api.js'))
  const requested = [...panel.matchAll(/callHost\('([^']+)'/g)].map((match) => match[1])
  assert.ok(requested.length > 0, 'the panel calls nothing, so this test proves nothing')
  for (const action of new Set(requested)) {
    assert.ok(PLUGIN_PANEL_ACTIONS.includes(action), `${action} is not panel-callable`)
  }
})

test('the panel loads nothing over the network, which the CSP would block anyway', () => {
  for (const forbidden of [/\bfetch\s*\(/, /XMLHttpRequest/, /<script[^>]+src=/i, /<link\b/i, /<img\b/i, /url\(\s*['"]?https?:/i]) {
    assert.ok(!forbidden.test(panel), `panel uses ${forbidden}`)
  }
})

test('the panel refuses a baseline that could end the shell command', () => {
  const pattern = /const REF = (\/.+\/)\n/.exec(panel)
  assert.ok(pattern, 'no ref validation found in the panel')
  const ref = new RegExp(pattern[1].slice(1, -1))
  for (const hostile of ['release; echo owned', 'a`id`', '$(id)', 'a b', 'a\nb', 'a|b', "a'b"]) {
    assert.ok(!ref.test(hostile), `${JSON.stringify(hostile)} passed ref validation`)
  }
  for (const legitimate of ['origin/HEAD', 'origin/main', 'v1.2.3', 'release-2026.08', 'feat/a_b']) {
    assert.ok(ref.test(legitimate), `${legitimate} was rejected`)
  }
})
