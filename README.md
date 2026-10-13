# Rewind

> This copy runs read-only on Railway as a recorded showcase. The interactive deployment is
> [Rewind-debugger](https://github.com/krishivseth/Rewind-debugger) on Replit.

Rewind is a time-travel debugger for coding-agent sessions. It records every step an agent takes on
a repository, lets you scrub back to any step and see the exact repository state and the exact
messages the model saw, fork from that step with a different model or an edited prompt, watch the
branches run side by side, diff any two of them, and line up every fork of a branch to find where
they diverged.

**Live:** https://rewind-production-a902.up.railway.app

It runs three ways from the same code: locally with `pnpm`, in Docker on any host, or on Replit.
The link above is the Docker image on Railway with a Postgres service and a persistent volume.
One long-running Node process serves the API, the live event streams, the agent workers and the
built frontend.

- [Two-minute tour](#two-minute-tour)
- [Quick start (local)](#quick-start-local)
- [Docker](#docker)
- [Replit](#replit)
- [Using it](#using-it)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [API](#api)
- [Data model](#data-model)
- [Seed repositories](#seed-repositories)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Repository layout](#repository-layout)

## Two-minute tour

1. Open the deployment. The home page explains the idea and links "Start here" to the session
   with the most forks.
2. Drag the scrubber or press `→` a few times. The file pane shows the repository at that exact
   commit; changed files are marked.
3. Press `C`. That is the full message array the model saw at this step, with its token count.
4. Press `F`, pick 2 copies, fork. Two new branches appear in the tree and stream live. Visitors can
   do this without a key on the cheap model.
5. When they finish, click "compare 2 forks" under the parent. The view lines the forks up and
   marks the first step where they diverged, with a "Fork here" button at that step.
6. Shift-click one fork while another is selected for a side-by-side diff of their final code.

## Quick start (local)

Requirements: Node 20.12 or newer (24 recommended), pnpm 10, git, Python 3 with the `venv` module,
Docker for Postgres, and an [OpenRouter](https://openrouter.ai) API key.

```bash
git clone https://github.com/krishivseth/Rewind-debugger.git && cd Rewind-debugger
docker run -d --name rewind-pg -p 5432:5432 -e POSTGRES_PASSWORD=rewind -e POSTGRES_DB=rewind postgres:16
cp .env.example .env            # then set OPENROUTER_API_KEY and REWIND_ACCESS_KEY
pnpm install
pnpm dev                        # API + workers on :8080, UI on :5173 (proxies /api)
```

Open http://localhost:5173. The schema is created on first boot; there is no separate migrate step.
The first boot also builds a small Python venv with pytest and flask under `DATA_DIR` for the seed
repositories' tests; the top bar says "sandbox warming up" until it is ready, usually under a minute.

Production-style, one process serving everything on :8080:

```bash
pnpm build && pnpm start
```

Other root scripts: `pnpm test` (both suites), `pnpm seed` (creates the demo sessions through the
API, needs `REWIND_ACCESS_KEY` and a running server), `pnpm db:push` (drizzle-kit push; optional,
the server migrates itself).

`.env` is read from the repository root by the API server and the seed script. Replit and Docker
supply real environment variables instead and need no `.env`.

## Docker

```bash
export OPENROUTER_API_KEY=sk-or-...  REWIND_ACCESS_KEY=$(openssl rand -hex 16)
docker compose up -d --build        # app on :8080, Postgres 16, data volume at /data
```

The image runs as an unprivileged user, migrates the schema on boot, seeds the repositories, builds
the sandbox venv, and tries `unshare -n` for the sandbox (works under Docker Desktop and most
hosts). `APP_PORT` moves the published port. Put a TLS proxy in front with buffering off for SSE.

## Replit

The repo is a Replit pnpm workspace with two artifacts: `api-server` on `/api` and the static web
app on `/`.

1. Add the secrets `OPENROUTER_API_KEY` and `REWIND_ACCESS_KEY`. The Postgres module sets
   `DATABASE_URL`. Provision App Storage so `PRIVATE_OBJECT_DIR` is set; without it bundles live in
   `/tmp` and vanish on redeploy (step history in Postgres survives either way).
2. Press Run. The API artifact builds and starts; the web artifact starts Vite.
3. Deploy as a **Reserved VM**, deployment type Web server. `.replit` already sets
   `deploymentTarget = "vm"`. Autoscale is request-scoped and would kill running branches. On the
   smallest machine set `MAX_CONCURRENT_BRANCHES=2`.
4. After deploying, open `/api/stats` on the deployment. `writes` should be `"open"`,
   `sandbox_python.ready` `true`, and `storage_backend` `"object"`.

The Replit pip proxy is not reachable from deployments, so the sandbox venv installs from
`pypi.org` directly and bootstraps pip itself; Nix pythons ship without `ensurepip`.

## Using it

**Home** lists sessions with a branch-length graph per session: one bar per branch, from its fork
step, as long as its step count, coloured by status. Search matches tool output, tool arguments,
model text and notes across every session and deep-links to the step.

**New session** picks a seed repository, a model and a task. Viewing is public. With
`REWIND_PUBLIC_WRITES=cheap` (the default) visitors can create sessions and forks on the cheap model
without a key, within the per-IP rate limit and a separate public daily budget; other models,
cancelling, deleting and notes ask for the access key once per browser tab. Set
`REWIND_PUBLIC_WRITES=off` for key-only writes.

**Session page**, three panes:

- Left: the branch tree. Root at the top, forks hang off the step they left from, labelled
  `fork 1`, `fork 2`... with model, status, step count and estimated cost. Click to select;
  shift-click a second branch for diff mode; "compare N forks" under any branch with forks.
- Centre: the scrubber, one tick per step coloured by kind (task, model, call, result), a dot under
  ticks that committed, a bar above ticks with notes, inherited steps dimmed on forks. Below it the
  selected step: model text, tool call arguments, tool output. **Context** opens the exact message
  array the model saw at that step with a token count. **Fork here** opens the fork popover.
- Right: the file tree at that step's commit with changed files marked, Monaco viewer, and
  "Diff vs previous step". Drag the divider to resize.

**Fork popover**: model, editable task prompt, 1 to 5 copies. Five copies of the same model and
prompt is the divergence experiment. If the chosen step is mid-turn the fork snaps back to the last
complete round and says so.

**Compare view** lines up every fork of one branch tick by tick, marks the first step whose
call differs, lists what each fork did there, and offers "Fork here" at that step.

**Diff mode**: side-by-side Monaco diff between two branches at any two steps, changed files listed.

Keyboard: `←` `→` step, `Home` `End` jump, `F` fork, `D` diff mode, `C` context, `Esc` close.

## How it works

```
 browser ── React + Vite ─────────────────────────────────────────────────────┐
   │  GET /api/...  (TanStack Query)        EventSource /api/branches/{id}/events
   ▼                                                                          ▼
 ┌──────────────────────── one Node process (api-server) ───────────────────────┐
 │ Express routes ──► services ──► Postgres (repos, sessions, branches, steps)  │
 │      │                             ▲                                         │
 │      │ POST /sessions, /fork       │ every step is a row: the exact message  │
 │      ▼                             │                                         │
 │ scheduler (≤4 running, FIFO) ──► runBranch()  ──► pubsub ──► SSE            │
 │                                     │                                        │
 │                     while not done: │ chat.completions(messages, 4 tools)    │
 │                                     ▼                                        │
 │                     tools: read_file · write_file · edit_file · run("test")  │
 │                                     │ each mutation = git commit             │
 │                                     ▼                                        │
 │             /tmp/rewind/branches/{branch_id}   (scratch worktree)            │
 │                                     │ on finish: git bundle --all            │
 │                                     ▼                                        │
 │   DATA_DIR/storage/bundles/{id}.bundle, or Replit App Storage                │
 │                                     │ on view: restore, git show {commit}:p  │
 │                                     ▼                                        │
 │             /tmp/rewind/restores/{branch_id}   (10-minute cache)             │
 └──────────────────────────────────────────────────────────────────────────────┘
```

- **Recording.** The agent loop (`artifacts/api-server/src/lib/loop.ts`) is a plain loop over an
  OpenAI-compatible chat completions API with four tools. We own the message array, so every
  message is stored exactly as sent or received. The context at step *k* is the system prompt plus
  the content of steps 0..*k*.
- **Commits.** Every file-mutating tool call is a git commit in the branch's worktree. Viewers never
  read the working tree; files come from `git show` at the step's commit, so the scrubber shows the
  state at exactly that commit even while the branch is still running.
- **Sandbox.** `run` accepts only names from the repository's `.rewind.json`. Commands execute with
  an environment of `PATH`, `HOME`=worktree and `PYTHONDONTWRITEBYTECODE` only, under `ulimit` for
  file size, process count and memory, with a 60 second timeout that kills the process group, and
  inside `unshare -n` where the host allows it. Paths are rejected on `..`, on resolving outside the
  worktree, on any symlink component, and under `.git/`.
- **Forking.** Copy the parent's steps up to the requested step, snapped back to the last point
  where the model's context was complete, restore the parent's history at that commit, and start
  the loop with a different model or an edited task. The fork's first model call sees exactly what
  the parent saw.
- **Durability.** Worktrees are scratch. Postgres holds the trajectory; bundles hold the git
  history. A running branch renews a lease; a crashed process's branches are failed on the next boot
  or sweep with their steps intact. Deleted sessions queue their bundles for removal with retries.
- **Limits.** Model calls, tokens per branch and per session, wall clock, a daily token cap, a loop
  detector (same call with the same arguments repeated), and a per-key and per-IP write rate limit.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | Postgres connection string |
| `OPENROUTER_API_KEY` | | Required to run branches |
| `REWIND_ACCESS_KEY` | | Required in `X-Rewind-Key` for writes |
| `DATA_DIR` | `./data` (`/tmp/rewind/data` on Replit) | Bundles (local backend), the sandbox venv |
| `PRIVATE_OBJECT_DIR` | | Set by Replit App Storage; bundles go to the bucket instead of disk |
| `PORT` | `8080` | API server port |
| `REWIND_READ_ONLY` | `0` | `1` refuses every write; leave a deployment public without spending credits |
| `REWIND_PUBLIC_WRITES` | `cheap` | `cheap`: anyone may run the cheap model; `signed_in`: only GitHub-signed-in visitors may; `off`: every write needs the key |
| `PUBLIC_MAX_MODEL_CALLS` | 15 | Model-call cap for keyless (public or signed-in) branches; the key gets `MAX_MODEL_CALLS` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | | GitHub OAuth app for sign-in. Register `https://<host>/api/auth/github/callback` for every host that serves the app, including `http://localhost:5173` for `pnpm dev` and `http://localhost:8080` for `pnpm start` |
| `SESSION_SECRET` | | HMAC key for the session cookie; any long random string |
| `PUBLIC_URL` | | Override the origin used for the OAuth callback when the app sits behind a proxy that rewrites Host |
| `PUBLIC_DAILY_TOKEN_CAP` | 500000 | Tokens per UTC day that keyless writes may spend before they are refused |
| `SANDBOX_PYTHON` | | Python to build the sandbox venv from, if `python3` is not the one you want |
| `TRUST_PROXY_HOPS` | `1` | Proxy hops to trust for the client IP used by the rate limit |

Limits:

| Variable | Default | What happens when hit |
| --- | --- | --- |
| `MAX_MODEL_CALLS` | 30 | Branch fails with "max steps hit"; disk state is committed and bundled |
| `MAX_OUTPUT_TOKENS_PER_CALL` | 4000 | Passed as `max_tokens` |
| `MAX_TOTAL_TOKENS_PER_BRANCH` | 150000 | Branch fails with "token limit hit" |
| `MAX_TOTAL_TOKENS_PER_SESSION` | 300000 | Forks refused; running branches fail with "session token budget hit" |
| `WALL_CLOCK_SECONDS_PER_BRANCH` | 600 | Branch fails with "wall clock limit hit" |
| `REWIND_DAILY_TOKEN_CAP` | 2000000 | New sessions and forks return 429 until UTC midnight |
| `MAX_CONCURRENT_BRANCHES` | 4 | Others queue; queue position is shown on the branch |
| `RATE_LIMIT_BRANCHES_PER_HOUR` | 10 | Per access key and per IP, in memory |
| `LOOP_WARN_AFTER` / `LOOP_FAIL_AFTER` | 3 / 4 | Same call and arguments N times in a row: warn, then fail (one earlier when it keeps failing) |
| `RUN_TIMEOUT_SECONDS` | 60 | `run` kills the process group |
| `TOOL_OUTPUT_LIMIT` | 20000 | Tool output truncation, in characters |
| `SANDBOX_MAX_FILE_MB` / `SANDBOX_MAX_PROCS` / `SANDBOX_MAX_MEMORY_MB` | 64 / 256 / 2048 | `ulimit` on the sandbox shell (memory limit Linux only) |
| `RUN_LEASE_SECONDS` | 900 | A branch whose lease lapses is failed by the sweep |
| `RESTORE_CACHE_SECONDS` | 600 | Restored bundles are deleted after this idle time |

Models are listed in `artifacts/api-server/src/lib/config.ts`: Claude Sonnet 5, GPT-5.4 Mini,
Gemini 3.8 Flash, Kimi K3 and DeepSeek V4 Flash, all via OpenRouter with tool calling. DeepSeek is
marked cheap and is used by the seed script and as the default in the forms.

## API

Reads are public. Writes need the `X-Rewind-Key` header.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/repos` | Seed repositories |
| GET | `/api/models` | Model list |
| GET | `/api/sessions` | Sessions, newest first, with branch summaries |
| POST | `/api/sessions` | `{ repo_id, title, task_prompt, model_id }` creates a session and its root branch and starts it |
| GET | `/api/sessions/{id}` | Session with the full branch tree |
| DELETE | `/api/sessions/{id}` | Remove the session, its branches, steps and bundles |
| GET | `/api/branches/{id}` | One branch, with `queue_position` while queued and `est_cost_usd` |
| GET | `/api/branches/{id}/steps` | All steps, ordered |
| GET | `/api/branches/{id}/steps/{i}/files` | File tree at that step's commit, changed paths flagged |
| GET | `/api/branches/{id}/steps/{i}/file?path=&with_previous=` | File content at that commit, optionally with the previous step's |
| GET | `/api/branches/{id}/steps/{i}/context` | The exact message array the model saw; a tool_call row resolves to its assistant turn |
| PUT | `/api/branches/{id}/steps/{i}/note` | `{ note }` |
| POST | `/api/branches/{id}/fork` | `{ step_index, model_id, edited_task_prompt?, count }`; returns the effective step and `snapped` |
| POST | `/api/branches/{id}/cancel` | Cancel a queued or running branch |
| GET | `/api/branches/{id}/events` | SSE: replays existing steps, then streams `step` and `status` events |
| GET | `/api/diff?a={branch}:{step}&b={branch}:{step}` | Unified diff and changed files between two commits; step defaults to last |
| GET | `/api/search?q=` | Substring search over tool output, arguments, model text and notes |
| GET | `/api/stats` | Tokens today, caps, `writes` state, sandbox python status, storage backend |
| GET | `/api/auth/check` | 200 if the key is valid, 401 with a reason otherwise |
| GET | `/api/health` | Liveness |
| GET | `/api/ready` | Readiness: pings Postgres, 503 when it does not answer (also `/api/healthz`) |

SSE event shape: `{ type: "step" | "status", data: <step row | branch> }`.

## Data model

`repos` (slug, bundle_key), `sessions` (repo_id, title, root_branch_id), `branches`
(session_id, parent_branch_id, fork_step_index, model_id, system_prompt, task_prompt, status,
error, step_count, token totals, bundle_key, lease_expires_at), `steps` (branch_id, index, kind,
content, tool_name, tool_args, tool_result, commit_hash, files_changed, tokens, latency_ms, note),
`bundle_cleanup_queue`. Step kinds are `user`, `assistant`, `tool_call`, `tool_result`; the
`assistant` row holds the full message including its `tool_calls`, and `tool_call` rows exist for the
scrubber only. Schema lives in `lib/db/src/schema/rewind.ts`; the boot migration in
`artifacts/api-server/src/lib/migrate.ts` is idempotent and also upgrades databases from the
earlier version of this app.

## Seed repositories

Directories under `seed_repos/`, bundled into storage on first boot. Each has a `.rewind.json`
naming the only commands the agent may run.

- **tiny-todo**: a Flask todo API with tests. Task: add a DELETE route with a test.
- **csv-stats**: a CSV statistics CLI with two deliberate bugs and two failing tests.
- **rate-limiter**: a token bucket with a check-then-act race and a failing concurrency test.
- **blank**: an empty Python project with pytest, for tasks that build something from scratch.

`pnpm seed` creates the demo sessions: csv-stats with a five-way fork at step 6, rate-limiter with
one fork each on two other models, and tiny-todo. About a cent of tokens; it uses the full hourly
write quota.

## Tests

```bash
pnpm --filter @workspace/db run push       # once, with DATABASE_URL pointing at a rewind_ts_test database
pnpm test
```

- `artifacts/api-server/test`: the phase-one round trip (record with a scripted fake model, bundle,
  restore, check out an earlier commit, fork twice), eleven sandbox tests that must fail closed
  (whitelist, `..`, absolute paths, symlinks, `.git`, limits, timeout, scrubbed environment), the HTTP
  API (auth, SSE replay, fork snapping, cross-branch diff, rate limit, daily cap, cancel, notes,
  search, delete, loop detection, twenty concurrent branches, write gating), and the migration from
  the old schema. 23 tests, `node --test`.
- `artifacts/rewind/src/__tests__`: the pure logic (divergence detection, step clamping, cache
  merging, fork labels). 9 tests, Vitest.

Tests default to `postgresql://postgres:rewind@localhost:5432/rewind_ts_test`; override with
`TEST_DATABASE_URL`.

## Troubleshooting

- **"The sandbox is still warming up"** on every write: `/api/stats` → `sandbox_python.error`. On
  Replit this was the internal pip proxy; the venv now installs from pypi.org. Set `SANDBOX_PYTHON`
  if `python3` on the host is unsuitable.
- **"The server has no REWIND_ACCESS_KEY configured"**: add the secret and redeploy. Deployments
  snapshot secrets at publish time.
- **Files pane says "no bundle"** or bundles disappear after redeploy: `storage_backend` is `local`
  and the disk is ephemeral. Provision App Storage (Replit) or mount a volume at `DATA_DIR`
  (Docker).
- **Branch failed with "stuck in a loop"**: the model repeated the same call with the same
  arguments; usually the test command was failing identically each time. Check the last tool result.
- **Branch failed with "server restarted while branch was in progress"**: the process died mid-run;
  steps up to that point are viewable and the branch can be forked from its last step.
- **Old sessions from the earlier version** open but render oddly: their steps were recorded by a
  different loop. Delete them from the home page.

## Known limitations

- **The agent can execute arbitrary code.** `run("test")` restricts the command string; pytest then
  imports whatever the agent wrote, as the server user. The sandbox scrubs the environment, applies
  `ulimit`, kills the process group on timeout, and tries `unshare -n`. It does not hide the
  filesystem or, without `unshare`, the network. Anyone holding `REWIND_ACCESS_KEY` can run code on
  the host.
- Everything is publicly viewable; the access key gates only writes.
- Rate limits and the run queue are in-process and reset on restart. Run one instance.
- Cost figures are estimates from list prices, not billed amounts.

## Repository layout

```
artifacts/api-server/   Express API, agent loop, sandbox, git and storage layers, tests
artifacts/rewind/       React + Vite frontend
lib/db/                 Drizzle schema and client
seed_repos/             the seed projects
scripts/dev.mjs         runs API and UI together
Dockerfile, docker-compose.yml, .replit, DECISIONS.md
```

See `DECISIONS.md` for every choice the spec left open.
