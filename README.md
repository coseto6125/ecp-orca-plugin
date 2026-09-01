# ECP Code Graph — Orca plugin

Keeps the [ecp](https://github.com/coseto6125/egent-code-plexus) symbol graph warm for
every worktree Orca creates, and puts index / impact / summary one click away.

Requires the `ecp` CLI on the machine that holds the worktree, and Orca >= 1.4.0.
The plugin does not install ecp; its panel can type the install line for you.

## Install

The plugin search box filters listings from registered sources; it is not an
install field. Add this repo as a marketplace source instead:

1. Settings → Plugins → Manage sources → add
   `https://github.com/coseto6125/ecp-orca-plugin.git` (ref `main`).
2. Install **ECP Code Graph** from the listing and approve the consent dialog.

The consent dialog names a trusted Node worker, which is accurate: `main` runs as
a forked Node process so it can spawn `ecp` for background indexing. Orca's own
wording is that the worker "runs as a normal process on this computer with full
access to your files, network, and other processes."

For local development, point Orca's plugin **Development** section at a clone of
this repo. Those are desktop paths, so a WSL clone is
`\\wsl.localhost\<distro>\home\<you>\ecp-orca-plugin`.

## What it does

| Trigger | Transport | Command |
|---|---|---|
| Worktree created | worker spawns ecp | `ecp admin index --repo <path>` |
| Panel button | terminal you picked, with Enter | index / impact / summary / install ecp |
| `ECP: Index this worktree` (`Mod+Alt+E`) | first terminal, no Enter | `ecp admin index --repo .` |
| `ECP: Impact vs base branch` | first terminal, no Enter | `ecp impact --baseline origin/HEAD` |
| `ECP: Index health` | first terminal, no Enter | `ecp summary` |

Auto-indexing runs in the worker because nobody needs to read its output. Two
indexes run at a time and eight more may queue; past that, an event is logged and
skipped, so a bulk worktree import never reaches the 64 pending events at which
the host kills the worker. The worker exports `deactivate`, so disabling the
plugin stops indexes it started rather than orphaning them.

Everything whose output matters goes to a terminal, because a worker can only
report through a 1000-character notification and `ecp impact` output is the point.

## Why there is no settings page

This Orca build has no editor for plugin-defined settings: `settings.get` /
`settings.set` is a private key-value store with no UI, and `settings.set` is not
panel-callable. A knob read by the worker would be a knob nobody can turn, so the
plugin has none. Choices that need a person live in the panel.

## Known edges

- **Terminal targeting is blind.** `workspace.readContext` returns terminal ids
  with no type, so nothing can tell a shell from an agent's TUI pane. The panel
  lists the ids and keeps its buttons disabled until you pick one; the keyboard commands take the first terminal
  and send **without Enter**, so a line that lands in an agent prompt sits there
  until you decide.
- **The panel is a launcher, not a viewer.** Panel documents run under
  `connect-src 'none'` and cannot call this plugin's worker, so no panel can show
  ecp output. That changes if Orca ships a `net:fetch` capability.
- **Plugins run on the Orca client machine**, even for SSH workspaces. The worker
  auto-indexes only a path that resolves here and contains `.git`, plus Windows
  UNC paths naming a WSL distro. A remote path that happens to exist locally is
  indistinguishable from a local one; the `.git` check rejects the accident, not
  the collision.
- **WSL needs a login shell to find ecp.** `wsl.exe -- ecp` runs without one, so a
  non-root install under `~/.local/bin` is off PATH there. The worker resolves the
  absolute path once per distro through `bash -lc` and reuses it.
- **Only `worktree.created` carries a path.** `workspace.readContext` gives branch
  and display name but no path, which is why the commands say `--repo .` and let
  the shell's cwd decide.

## Development

```
npm run validate   # both JSON files against the installed Orca's schemas,
                   # artifact containment, and the marketplace ref
npm test           # worker and panel tests
npm run smoke      # the worker under Orca's real plugin-host-entry.js
```

`npm run smoke` forks the installed Orca's worker runtime and answers its host
calls through the shipped host-API schemas, so a call the real host would reject
fails here. What none of it covers: the 30s command timeout, the 5-minute event
timeout, idle reap and re-fork, a real `wsl.exe`, and the panel's behaviour in a
live iframe.

## License

MIT
