# Security

Rewind records coding agents and classifies what they read and run. This file says what the
system trusts, what it exposes, and how to deploy it so a poisoned repository cannot hurt the host.
Read it before putting a Rewind server anywhere other than your own laptop.

## Threat model

Rewind assumes the **repository content the agent reads is hostile**: files, tool results and MCP
tool descriptions may contain instructions aimed at the agent. The detector (`backend rules + Jev`)
is built on that assumption, and so is the fork ledger, which never quotes tool output.

Rewind does **not** assume the people holding the access key are hostile. The key holder can start
agents, choose which directory they run in, delete sessions and spend tokens.

## What runs code, and where

| runner | what executes | isolation |
|---|---|---|
| `rewind` (built-in loop) | `read_file` / `write_file` / `edit_file` / `run` | `run` accepts only commands named in the repo's `.rewind.json`, in a scratch worktree, with a scrubbed environment, `ulimit`s, a 60 s timeout, and `unshare -n` where the host allows it |
| `opencode` (recorded) | whatever OpenCode's agent decides, including **unrestricted `bash`** (`permission.bash: allow`) | **none beyond the process environment**; the agent runs as the Rewind server's user in the project directory |

The OpenCode runner exists to record a real harness, and a real harness has a real shell. A poisoned
repository can therefore run arbitrary commands as the server user on the machine Rewind runs on.
That is the attack the detector is there to show you, and it means:

- **Run the OpenCode runner only inside a disposable container or VM** with no credentials you
  care about, no access to production networks, and a filesystem you can throw away. `docker
  compose` with the project directory mounted is the intended shape; a developer laptop is fine for
  a demo you are watching.
- The agent process gets a minimal environment: `PATH`, `HOME`, `LANG`, the OpenRouter key (OpenCode
  needs it for its provider) and its own server password. It does **not** inherit `REWIND_ACCESS_KEY`,
  `DATABASE_URL`, the GitHub OAuth secrets or `SESSION_SECRET`. The OpenRouter key is still exposed
  to the agent; use a key with a spending cap and rotate it if a run looks compromised.
- Each `opencode serve` is bound to `127.0.0.1` with a random per-process `OPENCODE_SERVER_PASSWORD`,
  so other local processes cannot drive its session API.
- `project_path` must resolve (symlinks included) to a directory under `OPENCODE_PROJECTS_ROOT`
  (default `/tmp/rewind/projects`). Put only throwaway clones there.
- Rewind writes `opencode.json` into the project (merged over any existing one) to pin the model and
  disable OpenCode's own snapshots, compaction and permission prompts. It never touches the project's
  `.git`; snapshots go to a Rewind-owned object store under `DATA_DIR/snapshots/`.

## What is public

Viewing is public by design: sessions, steps, tool results, file contents at every step, diffs,
classifications and explanations are readable without a key (`REWIND_PUBLIC_WRITES` controls writes,
not reads). **Anything the agent reads or prints becomes visible to anyone who can reach the server.**
Do not record an agent on a repository with secrets in it unless the server itself is private.

Writes need the access key or, when enabled, a GitHub sign-in (cheap model only). The OpenCode runner,
its forks, the inline classify endpoint, explanations, notes and deletes are key-only.

## What leaves the machine

Every tool result is sent to OpenRouter twice: to Jev (`typesafe/jev-1.13`) for the verdict, and, when
you ask for a part-by-part reading, to the configured cheap model. Agent prompts and tool results go to
whichever model runs the agent. If tool output may contain data that must not leave your network, do
not run Rewind against it, or point `OPENROUTER_BASE_URL` at a gateway you control.

## Model output is data

- The verdict stores enums and numbers only. Rules or the model can raise a flag; nothing can clear
  one. A classifier error is recorded as `classifier_error`, never as a flag.
- The explanation is the one place a generative model writes prose about a result. It is display-only,
  every quote must be a verbatim substring of the result (or it is dropped), and nothing from it reaches
  the ledger, a fork, or any decision.
- The ledger handed to a recover fork is built from structured fields: tool names, argument summaries,
  effect enums, commit hashes, file lists, reason enums. Argument summaries are attacker-influenceable
  (a file path is chosen by the agent, which reads attacker text), so they are truncated to 120
  characters; treat the ledger as untrusted input to the forked agent, which is what it is.
- The inline guard plugin blocks or withholds on `flag` only; it never follows text in a result.

## Inline guard

`REWIND_INLINE_GUARD=1` enables `POST /api/classify` (key-gated). The plugin in
`.opencode/plugins/rewind.ts`, copied into `<project>/.opencode/plugins/` with `REWIND_URL` and
`REWIND_KEY` set in the agent's environment, then consults it from `tool.execute.before` (throw to
block) and `tool.execute.after` (replace the result). Note that OpenCode persists streamed `bash`
output in its own local database before `tool.execute.after` runs, so a withheld result still exists in
`~/.local/share/opencode/opencode.db` on the agent host; the model never sees it.

## Reporting

Open a GitHub issue for anything that is not an active exploit. For an exploitable issue in a deployed
instance, email the maintainer listed in the repository profile instead of filing it publicly.
