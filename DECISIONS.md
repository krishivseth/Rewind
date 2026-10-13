# Decisions

Choices the spec left open, and what this codebase does about them.

## Architecture

1. **TypeScript, Express, Drizzle.** The spec asked for Python and FastAPI; this repo is the Replit
   submission and keeps the Replit monorepo layout (`artifacts/api-server`, `artifacts/rewind`,
   `lib/db`). The one-process rule is honoured where it matters: the API server hosts the routes, the
   SSE streams and the agent workers. On Replit the frontend is a separate static artifact routed on
   `/`; off Replit the API server serves the built frontend itself.
2. **Reserved VM, not Autoscale.** Autoscale is request-scoped and scales to zero, which would kill
   running branches. `.replit` pins `deploymentTarget = "vm"`.
3. **Access key instead of Clerk.** Viewing is public; writes need `X-Rewind-Key`. Clerk and its
   proxy middleware were removed. `sessions.user_id` stays in the schema, unused, so the migration is
   additive.
4. **Additive schema only.** `drizzle-kit push` prompts on drops and renames, and Replit's post-merge
   hook runs it non-interactively. New columns (`branches.error`, `created_by`, `steps.note`,
   `sessions.root_branch_id`) were added; nothing was dropped. The earlier upload-intent and
   alert-state tables are gone from the schema but harmless if they linger in an old database.
5. **Storage abstraction.** `storage.ts` keys blobs by relative path. Local disk under `DATA_DIR` by
   default; with `PRIVATE_OBJECT_DIR` (Replit App Storage) the same keys go to the bucket. Replit
   deployments have an ephemeral filesystem, so the bucket is what makes bundles durable there.
6. **Sandbox python is a venv under DATA_DIR** with pytest and flask, built on first boot from
   whatever `python3` is on PATH (Replit's `python-base-3.12` module). Its bin is prepended to the
   sandbox `PATH`; the host's python is never assumed to have anything installed.

## Trajectory model

7. **System prompt is not a step.** It lives on the branch; step 0 is the user task. Context at step
   k is `[system] + content of steps 0..k`.
8. **`tool_call` rows are not messages.** The assistant row carries the full message including
   `tool_calls`; each call also gets its own row for the scrubber. Rebuilding the message array skips
   `tool_call` rows. `/context` on a `tool_call` row returns the owning assistant step's context and
   says so with `requested_index` vs `step_index`.
9. **Forks copy the parent's steps** up to the boundary, so context and scrubber work the same on
   root and fork branches. `fork_step_index` is the effective boundary; the fork endpoint returns
   `requested_step_index`, `fork_step_index` and `snapped`, and the tree hangs forks off the effective
   step. Inherited steps carry zero token counts and keep their notes.
10. **Boundary snapping.** A fork at a `tool_call` row, or a `tool_result` whose turn still has
    unanswered calls, moves back to the end of the previous complete round.
11. **`MAX_MODEL_CALLS` counts model calls**, not rows. Inherited rows never count against a fork.
12. **Every mutating tool call commits**, even a no-op (`--allow-empty`); `run` commits only if it
    dirtied the tree. Seed repos ignore caches and run pytest with `-p no:cacheprovider`.
13. **Token count in `/context`** is the prompt size reported by the next model call when there is
    one, else a chars/4 estimate, and the response says which.

## Sandbox

14. **Whitelist, then `ulimit`, then exec.** Commands come from `.rewind.json`, are split without a
    shell, and run under `/bin/sh -c 'ulimit -f/-u/-v ...; exec "$0" "$@"'` with only `PATH`,
    `HOME`=worktree and `PYTHONDONTWRITEBYTECODE` in the environment. Timeouts kill the process
    group. `ulimit -v` is Linux only.
15. **Paths** are rejected on `..`, on resolving outside the worktree, on any symlink component
    including the leaf, and under `.git/`. Absolute paths are allowed only if inside the worktree.
16. **`read_file` on a directory lists it.** Without this a model that guesses a wrong filename has
    no way to recover and tends to loop. Still four tools.
17. **`unshare -n` / `-rn`** is tried on Linux and re-probed every ten minutes; most containers
    refuse it and the sandbox keeps the host network. The boot log says which mode you got.
18. **Loop detection.** The same tool with the same arguments three times in a row appends a warning
    to the result; a fourth time fails the branch. Output is not part of the signature (test timings
    vary). An edit between two test runs resets the streak.

## Operations

19. **Run leases.** A running branch renews `lease_expires_at` every few minutes; boot fails every
    non-terminal branch (workers died with the process) and a five-minute sweep fails any whose lease
    lapsed. Surviving worktrees are bundled first so steps stay viewable.
20. **Deletion queues bundles** in `bundle_cleanup_queue` and drains it with retries, so a storage
    hiccup never leaks a bundle. There is no branch-level delete: removing a mid-tree node would
    orphan its forks.
21. **Rate limits and the queue are in memory.** One process by design; a restart resets them.
22. **Daily token cap** sums tokens of branches created since UTC midnight and is checked before
    every create or fork. Running branches finish.
23. **Retries** are the OpenAI SDK's own: 408/409/429/5xx and connection errors with backoff, four
    attempts; 402 and other 4xx fail the branch immediately.
24. **Model ids** were verified against OpenRouter's public model list on 2026-09-09.

## Frontend

25. **Bundled Monaco**, no CDN. IBM Plex Sans and Mono from Google Fonts with system fallbacks.
26. **Scrubber semantics.** Tick height encodes kind, a dot marks a commit, an accent bar marks a
    note, inherited steps on a fork are dimmed and the fork point is a dashed line. Selecting the last
    step while live means "follow along".
27. **One SSE subscription per live branch** in the session so the whole tree moves. Terminal status
    closes the stream and refetches once.
28. **Compare view** lines up every fork of one parent and marks the first step whose signature
    (kind, tool, arguments; for results, committed and errored) differs. Output and timing are never
    part of the signature.
29. **Home cards** show a branch-length graph: one bar per branch, from its fork step, as long as its
    step count, coloured by status.
30. **Model text is rendered** with a 40-line inline renderer: paragraphs, lists, code, bold, fences.
31. **Frontend tests** cover the pure logic only (divergence, step clamping, cache merging, fork
    labels); components are exercised by hand in the browser.
32. **Visual theme is the Replit design's**: near-black navy, teal primary, amber accent, Space
    Grotesk for prose, IBM Plex Mono for data, square corners, small uppercase tracked labels, dotted
    ground. Kind colours: task sky, model violet, call amber, result teal. Only the skin changed; the
    components and behaviour are the port's.
33. **A remembered pane width is ignored** when it would leave the centre pane under 800px of room;
    the default split applies instead. Narrow windows never lose the scrubber.

## After the first Replit deploy

34. **Writes wait for the sandbox.** The venv builds after boot; until it is ready, session and fork
    requests return 503 "warming up" and the UI disables the buttons, instead of recording runs
    whose every test command fails.
35. **Sandbox pip uses the public index** with the host's pip config ignored: Replit's workspace pip
    points at an internal proxy the deployment VM cannot resolve. pip itself is bootstrapped from
    ensurepip or get-pip.py because Nix pythons ship without it.
36. **Identical failures end a loop one call earlier** than identical successes (3 vs 4): a failing
    command repeated verbatim has no chance of a different outcome.
37. **Per-session token budget** (300k) caps a runaway five-way fork without touching the daily cap.
38. **Read-only mode** (`REWIND_READ_ONLY=1`) is how the deployment stays public after the demo.
39. **Cost estimates** (`est_cost_usd`, from the model's list price) show on tree nodes, the top bar
    and the compare table. The compare table offers "Fork here" at the divergence step.
40. **Legacy bundle keys** from the first version (`/objects/rewind/bundles/...`) resolve to their
    old bucket path so those branches can still be opened and deleted.
41. **Three run modes, one code path.** `pnpm dev` runs API and Vite together (`scripts/dev.mjs`,
    no extra dependency); `pnpm build && pnpm start` serves everything from the API process; the
    Dockerfile does the same in a container; Replit runs the two artifacts through its path router.
    `.env` at the repo root is loaded by a module imported first in the API entrypoint, using
    Node's built-in loader, so local runs need no dotenv package and deployments need no `.env`.
42. **Root build skips the mockup sandbox.** It is Replit agent scaffolding with its own type
    errors and no part of the product; `pnpm build` typechecks and builds only the API and the UI.
43. **Hardening after review.** 500s return a generic message with the detail in the log; the boot
    migration runs under a Postgres advisory lock inside one transaction; `/api/ready` (and
    `/api/healthz`, the Replit health path) pings the database while `/api/health` stays a cheap
    liveness probe; the rate limit uses `req.ip` behind one trusted proxy hop instead of the first
    `X-Forwarded-For` entry. Declined from the same review: locking the parent on fork (steps are
    append-only, so nothing at or below the boundary can change) and durable cancellation (a restart
    fails every non-terminal branch, so there is nothing to cancel afterwards).
44. **Selection state resets per session.** The zustand store outlives the route, so diff and compare
    selections used to leak into the next session opened. Deep links validate the step as a
    non-negative integer. The delete control on home cards is a sibling of the link, not a child.

## Public demo

45. **Visitors can fork on the cheap model without a key** (`REWIND_PUBLIC_WRITES=cheap`, the
    default). The spec gates every write behind the key; for a public demo that hides the product's
    point, so keyless writes are allowed for the cheap model only, counted against the per-IP rate
    limit and a separate `PUBLIC_DAILY_TOKEN_CAP` (500k tokens, about five cents of DeepSeek). The
    key still unlocks other models, cancel, delete and notes. `off` restores the spec's behaviour.
46. **Home page explains itself** in three sentences and links "Start here" to the session with the
    most branches. A dismissable one-line hint sits under the scrubber on first visit.
47. **Monaco loads on demand.** The file viewer, diff view and compare view are lazy chunks, so the
    first paint of a session is the 100 KB app bundle, not the 1 MB editor.
48. **Relative `DATA_DIR` resolves against the repository root**, not the working directory:
    `pnpm dev` runs the API from `artifacts/api-server` and `pnpm start` from the root, and a data
    directory that moves between them made a finished parent's bundle vanish. A missing parent
    bundle now fails the fork with a clear message instead of silently cloning the base repo.
49. **Seed session titles are for humans**: "Five identical forks of one bug fix", "Same task, three
    models", "Add a feature to a small Flask app".

## Railway showcase

50. **The Railway deployment is a read-only showcase.** `REWIND_READ_ONLY=1` and
    `REWIND_PUBLIC_WRITES=off` on the service: no sessions, forks, cancels, deletes or notes; the UI
    hides those controls and says the runs are recorded. Five curated sessions, fourteen branches,
    recorded with DeepSeek V4 Flash roots and GPT-5.4 Mini and Gemini 3.8 Flash comparison forks,
    live in its Postgres and volume. The Replit deployment of the same code stays interactive.
51. **Phones show one pane at a time.** Below the md breakpoint the session page keeps the scrubber
    on top and switches the body between Steps, Files and Branches with a bar at the bottom; diff and
    compare modes jump to Steps. Stacking all three panes gave each a sliver of a 780px screen. The
    top bar drops the subtitle and token readout on small screens and the home search fills the bar.
52. **Egress.** Responses are gzipped in-process (except SSE) because the platform meters bytes
    leaving the container, not what its edge later compresses; hashed assets under `/assets` are
    `immutable, max-age=1y` and `index.html` is `no-cache`; Monaco is built from the core editor plus
    the ten languages the seed repos use instead of the full package, 4.0 MB down to 2.7 MB raw.
    A first visit that opens a file costs about 0.8 MB of egress instead of 4.3 MB; a return visit
    costs a few kilobytes of API JSON.
53. **Sign in with GitHub** (`REWIND_PUBLIC_WRITES=signed_in`). Keyless writes need a GitHub
    session: the OAuth token is used once to read the profile and dropped; the session is an
    HMAC-signed cookie with id, login and avatar, 30 days. Signed-in visitors get the cheap model,
    a per-account quota (the same ten an hour as a key, keyed by GitHub id instead of IP), the shared
    public daily budget, and `PUBLIC_MAX_MODEL_CALLS` (15) instead of 30. The access key still
    unlocks everything. Chosen over Clerk (the original Replit sign-in) because it needs one OAuth
    app and no vendor, and over a CAPTCHA because an accountable account deters bots better.
54. **Two Railway environments.** `production` is the live showcase; `staging` gets its own
    Postgres and volume for testing deploys of the same code before they reach production.
55. **Forks before the first commit reset to the base commit.** A fork whose boundary precedes any
    commit used to inherit the parent's finished worktree, so "five identical forks from step 3"
    were really forks of the solved repo and reported the tests already passing. The worktree now
    resets to the repository's root commit in that case. Regression test added; the two affected
    showcase sessions were re-recorded.
56. **The call cap ends with a wrap-up, not a failure.** When a branch reaches its model-call limit
    the last call is made without tools and asks for a summary; the branch ends `done` with a note
    saying it stopped at the limit. A 15-call run that had just made its tests pass used to be
    marked failed for running them once more. Keyless branches get 20 calls (was 15); the key gets 30.
57. **The blank seed repo ships one passing placeholder test**, so pytest exits 0 before the agent
    has written anything; "no tests ran" (exit 5) read as failure and sent models down the wrong path.
58. **Stop reason is separate from status.** Every branch records why it stopped: `completed`,
    `call_limit`, `loop`, `token_budget`, `wall_clock`, `cancelled`, `provider_error`, `crash`. The
    four limits are soft stops: the run makes one tool-less wrap-up call for a summary and ends
    `done`, the UI shows a "paused" badge with the reason, and a Continue button forks from the last
    step with the same model. Only provider errors and crashes are `failed`. A visitor's run hitting
    a budget is a pause they can resume, not a red failure on a demo.
59. **The system prompt covers the no-tests case**: write a small pytest file; "no tests ran" is not
    a failure. Both this and the placeholder test came from watching a signed-in run on staging.
