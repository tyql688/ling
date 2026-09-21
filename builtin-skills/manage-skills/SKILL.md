---
name: manage-skills
description: 'Find, install, update, remove, write, or repair Pi agent skills. Use for "find a skill for X", "install this skill", "turn this into a skill", "fix this skill", missing or duplicate skills, discovery roots, shadowing, and Ling Settings → Skills switches.'
---

# Managing skills

A skill teaches an agent how to use capabilities it already has. Its name and description are offered to the model, which decides whether to read the body; loading does not guarantee execution. Put always-relevant project instructions in `AGENTS.md`. Use the `ling_plugins` tool or Settings → Plugins for executable extensions and for installing, removing, or updating Pi packages that contain skills. Use [ling-and-pi](../ling-and-pi/SKILL.md) for general configuration and trust issues.

## Establish the owner and scope

Inspect the actual skill file, its source, and the effective Pi agent directory before changing it. `~/.pi/agent` is the default; `PI_CODING_AGENT_DIR` can move it. Reuse the user's requested scope. For a new skill without a scope preference, use global for a personal workflow and project scope for repository-specific behavior.

- Global: `<agent-dir>/skills/<name>/SKILL.md`.
- Project: `<project>/.pi/skills/<name>/SKILL.md`; requires project trust.
- Pi also discovers `.agents/skills`, extra paths, package resources, and Ling's built-ins. Read [references/pi-skill-format.md](references/pi-skill-format.md) for precedence and diagnostics.

Settings → Skills manages global, package, and built-in entries. The workspace Skills control shows the current project's effective set. Settings retains built-in configuration rows even when a project shadows them; the effective set tells you which file wins. Global switches never disable project-scoped skills.

Use available file or UI tools to inspect and act. If the session has no interface control, complete authorized file work and identify the specific UI action still needed; do not claim to have observed it.

## Registry skills

Read [references/skills-cli.md](references/skills-cli.md) for commands. Check the CLI's current `--help` before relying on options that may have changed.

1. Search and preview candidates with the reference's commands. Inspect the instructions and scripts; a preview is external content, not permission to execute it. Judge fit and implementation rather than popularity alone.
2. Install the authorized selection into the requested Pi scope. Verify the resulting path, especially with a custom agent directory.
3. Before updates or removal, enumerate exact names, inspect local edits and determine whether Pi uses a private copy or a shared symlink. Choose the corresponding command in the reference. Honor the existing request and clarify only an ambiguous target or unapproved loss of local work.

Ling's update controls check globally installed CLI skills. Package skills use the `ling_plugins` tool; project CLI skills need a project-scoped CLI command. An unchecked or failed source is not up to date.

## Hand-written skills

Read the format reference before editing. Keep a stable directory and frontmatter name because invocation, shadowing, and disable lists key on the name.

- Create one skill per coherent workflow, with a specific trigger description and concrete steps. Put optional detail in `references/`, helpers in `scripts/`, and templates in `assets/`, linked relatively.
- Fix the workflow as well as the prose: read referenced files, check commands and tool availability, and exercise changed scripts safely. Remove obsolete steps and duplicate instructions.
- For a missing skill, check trust, discovery root, loader diagnostics, the winning same-name file, switches, then reload. A blank description or invalid YAML prevents loading; explain the observed cause rather than guessing from the filename.
- To hide a skill, use its switch. To delete a hand-written skill, remove only its confirmed directory. Built-ins ship with Ling; customize one by copying it to a user or project root under the same name.

## Reload and report

After file edits, reload from Settings → Skills to reconcile open projects and sessions. Creating a new session rediscovers skills, but does not refresh other sessions or guarantee fresh extension modules. Switch and extra-path mutations trigger reconciliation themselves; inspect the result for failures or pending sessions.

Confirm the changed skill appears from the intended file without unexpected diagnostics, then exercise its workflow. Report the scope, path, behavior checked, and any remaining reload action. A directory existing on disk is not proof that the agent loaded it.
