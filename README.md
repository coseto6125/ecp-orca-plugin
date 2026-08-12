# ECP Code Graph — Orca plugin

Keeps the [ecp](https://github.com/coseto6125/egent-code-plexus) symbol graph warm for
every worktree Orca creates, and puts `index` / `impact` / `doctor` on a keystroke.

Requires the `ecp` CLI on the machine that holds the worktree, and Orca >= 1.4.0.

## Install

The plugin search box filters listings from registered sources; it is not an
install field. Add this repo as a marketplace source instead:

1. Settings → Plugins → 管理源 / Manage sources → add
   `https://github.com/coseto6125/ecp-orca-plugin.git` (ref `main`).
2. Install **ECP Code Graph** from the listing and approve the consent dialog.

The consent dialog names a trusted Node worker, which is accurate: `main` runs as
a forked Node process so it can spawn `ecp` for background indexing.

For local development, point Orca's plugin **Development** section at a clone of
this repo instead. Run `node scripts/validate.mjs` first: it checks both JSON
files against the schemas of the Orca build installed on this machine.

## What it does

| Trigger | Transport | Command |
|---|---|---|
| Worktree created | worker spawns ecp | `ecp admin index --repo <path>` |
| `ECP: Index this worktree` (`Mod+Alt+E`) | terminal | `ecp admin index --repo .` |
| `ECP: Impact vs base branch` | terminal | `ecp impact --baseline <baseline>` |
| `ECP: Doctor` | terminal | `ecp doctor` |
| `ECP: Install or update the CLI` | terminal | the ecp install script |

Auto-indexing runs in the worker because nobody needs to read its output. Every
other command goes through a terminal, because a worker can only report back
through a 1000-character notification, and `ecp impact` output is the point.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `autoIndex` | `true` | Index a worktree when Orca creates it |
| `ecpPath` | `ecp` | Executable used by the worker |
| `wslDistro` | from the path | Distro passed to `wsl.exe -d` |
| `baseline` | `origin/main` | Ref for `ecp impact --baseline` |
| `terminalIndex` | `0` | Which terminal of the focused worktree receives text |
| `terminalEnter` | `true` | Press Enter after sending |

## Known edges

- **Terminal targeting is blind.** `workspace.readContext` returns terminal ids
  with no type, so the plugin cannot tell a shell from an agent TUI pane. Index 0
  is a guess; set `terminalIndex` if commands land in the wrong pane.
- **Plugins run on the Orca client machine**, even for SSH workspaces. The worker
  auto-indexes only paths that resolve on this filesystem, plus Windows UNC paths
  that name a WSL distro. Anything else is left to the terminal commands.
- **Only `worktree.created` carries a path.** `workspace.readContext` gives branch
  and display name but no path, which is why the commands say `--repo .` and let
  the shell's cwd decide.
- **No panel.** Panel documents are served under `connect-src 'none'` and cannot
  call the plugin's worker, so a panel could only be a row of buttons. It becomes
  worth building when Orca ships a `net:fetch` capability.

## License

MIT
