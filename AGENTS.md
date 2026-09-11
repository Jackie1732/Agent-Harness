# Autonomous Harness Collaboration

These instructions apply to the entire autonomous Agent Harness repository.

## Scope

- Keep implementation, tests, configuration, and project notes inside this repository.
- Treat the parent DeepSeek Harness checkout and Cordis source as read-only references unless the user explicitly expands the task.
- Read `README.md`, `notes/commit-queue.md`, and the active Step note before changing code.

## Step branches and queue

- Persistent branches use only `step<number>`, for example `step0` and `step1`. All agents working on one development stage contribute sequentially to that stage branch.
- Distinguish agents through each commit's Git author and committer plus an `Agent:` trailer. Use `Codex <codex@agent.local>`, `DeepSeek <deepseek@agent.local>`, or `Claude <claude@agent.local>` and the matching trailer value.
- Do not set a repository-wide agent identity because the same checkout serves several agents. Supply `user.name` and `user.email` on each automated commit.
- Add or update one row in `notes/commit-queue.md` for the contribution.
- Do not modify or commit another agent's active work without an explicit handoff recorded in the queue.
- Start new work from the exact accepted base named in the queue. Fetch before using a remote base.
- Never rewrite another agent's published commits. Do not use a raw force push.

## Implementation

- Preserve the staged development order in the active Step note.
- Add only abstractions required by the current Step. Record later ideas as notes instead of placeholder APIs.
- Keep public types, runtime behavior, tests, and documentation consistent in the same contribution.
- Keep generated output, dependencies, credentials, and runtime data out of commits.

## Validation

- Run `pnpm install --frozen-lockfile` when dependencies or the Lockfile change.
- Run `pnpm run check` before every commit and push.
- Record only commands actually executed. A passing unit test does not prove a real model, network, or external-system path.

## Commits and pushes

- Use a concise conventional-commit title.
- Put the concrete behavior, important design choices, and executed validation in the commit body.
- Push only the active Step branch and verify the remote branch resolves to local `HEAD`.
- Update the queue after a handoff, supersession, push, or landing. Preserve older rows as history.
