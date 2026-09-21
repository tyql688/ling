# The `skills` CLI (skills.sh) with Pi

Community registry: <https://skills.sh/>. The [upstream CLI](https://github.com/vercel-labs/skills) owns installation and lock-file behavior. Commands below were checked against CLI 1.5.24, and its install-layout and update rules again on 1.5.26; inspect `npx skills --version` and `npx skills --help` before relying on another version. Installation needs an available Node/npm toolchain; Ling bundling npm for its own operations does not put `npx` on the agent shell's PATH. Pass `--agent pi` on add/remove/list to target Pi.

| Task | Command | Lands in |
| --- | --- | --- |
| Search | `npx skills find <query> [--owner <owner>]` | — (prints `owner/repo@name`, installs, URL) |
| Preview without installing | `npx skills use <owner/repo@skill>` | — (prints a prompt containing the selected skill) |
| List a repo's skills | `npx skills add <owner/repo> --list` | — |
| Install globally | `npx skills add <owner/repo@skill> -g -y --agent pi` | `~/.pi/agent/skills/<skill>/` |
| Install into the project | `npx skills add <owner/repo@skill> -y --agent pi` (run in the project root) | `<project>/.pi/skills/<skill>/`, tracked by `skills-lock.json` |
| Scaffold | `npx skills init <name>` | `./<name>/SKILL.md` — move it into a root yourself |
| Update global skills | `npx skills add <owner/repo> --skill <name> -g -y --agent pi` (add `universal` for a shared install — see below) | refreshes the files Pi loads, in place |
| Update project skills | `npx skills update <names...> -p -y` | updates the named installations in the current project, and in every other detected agent's project directory |
| Remove | `npx skills remove <name...> --agent pi [-g] -y` | removes Pi's selected skill links and updates CLI bookkeeping; inspect other agents' shared copies before deleting them |
| List installed | `npx skills list --agent pi --json` / `npx skills list --agent pi -g --json` | project / global inventory |

The CLI writes one shared copy under `~/.agents/skills` and symlinks each named agent to it when several agent directories are involved; a single target directory makes it copy into that directory instead, and `--copy` forces copies for every target. Both load in Pi. Ling reads CLI lock files for source labels and global update checks. Prefer CLI removal over manually deleting shared directories and leaving stale links or ledger entries.

## Scope and shared copies

The checked CLI uses `~/.pi/agent/skills` as Pi's global destination and does not read `PI_CODING_AGENT_DIR`. Compare the destination with Ling's effective discovery roots before installing. If the requested custom directory is unsupported by the installed CLI, use file tools to place the reviewed skill and its resources in that Pi root and report it as a manual installation; do not claim CLI tracking or automatic updates for it.

The existing install layout decides which command refreshes a global skill without reaching another agent:

- Pi's entry is a real directory holding the skill's files — the skill is Pi's own copy, so name only `pi`. A single target directory makes the CLI copy into it, confining the refresh to `~/.pi/agent/skills/<skill>/`.
- Pi's entry is a symlink into the shared store (`~/.agents/skills`) — name `pi` and `universal`. The CLI then rewrites the shared copy and keeps Pi's link to it. Naming only `pi` would replace that link with a private copy, and because Pi reads both `~/.pi/agent/skills` and `~/.agents/skills`, two versions of one name would shadow each other.

`universal` is the CLI's own id for the shared store. A release that renames it fails the command with `Invalid agents` instead of silently changing the layout.

`update` accepts names and global/project scope but has no agent selector at all. It refreshes every agent the CLI detects on this machine: a global update creates or refreshes those agents' links and can migrate a Pi-only copy into the shared store, and a project update writes every detected agent's project directory. Use it when that broader change is what the user asked for; do not promise an update limited to Pi through it. Preserve local edits and requested source refs; an empty name list is a batch operation, not a substitute for selecting the user's target.

Read skipped and failed update messages even when the CLI exits successfully. A source it could not check is not proven current. Verify the resulting files and Ling's effective skill path after each mutation.

The [parent workflow](../SKILL.md) owns candidate selection, reload and acceptance.
