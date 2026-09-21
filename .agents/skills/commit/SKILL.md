---
name: commit
description: General git commit workflow. Use when staging changes, splitting commits, reviewing a commit boundary, or writing and creating commits. Follow repository conventions, preserve unrelated work, and verify the staged result.
---

# Commit workflow

## Establish scope

Read `git status --short`, repository guidance, and recent commit subjects. Inspect staged and unstaged diffs separately and read relevant untracked files. Identify the requested commit boundary before changing the index. A request to commit the task's changes and a request to commit all current pending work have different scopes; honor the one the user gave.

Preserve pre-existing staged work. If it is outside the requested commit, keep it out of the new commit without discarding its working-tree changes, and restore its staged state afterward. Use the existing Git identity. A normal commit request authorizes a new commit; amending history, changing identity, pushing, tagging, and publishing each need their own authorization.

## Stage and review

- Prefer explicit paths; use hunk staging when a file contains unrelated changes. Inspect deletions and untracked companion files as well as modifications. Stage the whole worktree only when that matches the requested scope.
- Keep coupled moves, contracts, locale pairs, and required lockfile changes together. Split independently reversible changes when intermediate commits can remain coherent.
- Exclude generated build output, runtime data, credentials, and temporary probes unless the repository deliberately tracks them.
- Inspect `git diff --cached --stat`, the complete staged diff, and `git diff --cached --check`. Check deletions and rename matches as carefully as new code.
- If formatting changes a staged file, review and re-stage that output.

## Verify

Select verification from [AGENTS.md](../../../AGENTS.md) according to the changed behavior. A commit does not itself require a full suite, new test files, or a dev smoke. Reuse successful checks already performed in this task only when they cover the same candidate content and relevant environment; changes or unresolved failures require fresh relevant verification.

Verify what will be committed. A green working-tree check can depend on unstaged fixes absent from a partial commit; inspect that dependency and, when needed, validate the staged candidate in an isolated checkout. Do not expand the commit to unrelated work just to make a check pass. Report a real blocker with its evidence rather than claiming static checks prove runtime behavior.

## Write the commit

Follow established repository style. Ling uses an emoji and imperative English subject, for example `♻️ Separate runtime and domain ownership` or `🐛 Preserve project skill scope`. Aim for roughly 50 characters and keep it under 72. Omit a final period and generated-by or co-author footers unless requested.

Use a body only for a non-obvious motivation, compatibility decision, or relationship a future maintainer needs. Describe the final behavior, not the conversation or every touched file.

When commit creation is requested, create it and inspect its hash, full file list, and remaining staged/unstaged status. For a boundary or message review, stop at the requested review result. Report the commit and verification concisely; distinguish intentionally uncommitted work from an unexpectedly incomplete commit.
