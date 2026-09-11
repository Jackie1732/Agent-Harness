# Autonomous Harness Collaboration

These instructions apply to the entire autonomous Agent Harness repository.

## Scope

- Keep implementation, tests, configuration, and project notes inside this repository.
- Treat the parent DeepSeek Harness checkout and Cordis source as read-only references unless the user explicitly expands the task.
- Read `README.md`, `notes/commit-queue.md`, and the active Step note before changing code.

## Step branches and queue

- Persistent branches use only `step<number>`, for example `step0` and `step1`. All agents working on one development stage contribute sequentially to that stage branch.
- Every stage branch stays on the remote after its work merges, because the branch names the stage rather than its open pull request. `step0` is the accepted baseline: a stage branch is created from the exact baseline commit, and its work merges back into `step0`. The newest stage branch is the active one and takes the daily work.
- The next stage opens its own branch from the then-current `step0` instead of extending the merged stage branch. `step1` therefore holds the Step 1 work, and Step 2 begins on a new `step2`.
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

- Run the gate with `npm run <script>` from Windows Node, not with Linux `pnpm`. Installed dependencies carry Windows native bindings only, so `lint` and `test` cannot load under the WSL Linux runtime, and the `check` script calls `pnpm`, which is not on the Windows PATH. Run `lint`, `typecheck`, `test`, `build`, and `test:built` individually; together they equal `check`.
- Cross into Windows with the working directory inherited from WSL and relative paths. A non-ASCII path passed as a Windows argument is corrupted by ANSI codepage conversion, so never pass one.
- Run `npm install --frozen-lockfile` only when a dependency or the Lockfile changes.
- Record only commands actually executed. A passing unit test does not prove a real model, network, or external-system path.

## Commits and pushes

- Use a concise conventional-commit title.
- Put the concrete behavior, important design choices, and executed validation in the commit body.
- Push only the active Step branch and verify the remote branch resolves to local `HEAD`.
- Update the queue after a handoff, supersession, push, or landing. Preserve older rows as history.
