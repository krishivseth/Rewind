# OpenCode runner, security flags and rewind-aware forks

Date: 2026-09-28. Repository: Rewind-poc (TypeScript). Branch: `ai-security-flags`. Ported from the Python prototype's spec; the OpenCode facts were verified against the Python prototype's tooling on the same day.

## Goal

Turn Rewind into a flight recorder for agent compromise: record an OpenCode session step by
step, flag tool poisoning and dangerous side effects on the timeline, and fork from before the
compromise either blind (to prove causation) or informed (to recover, knowing what the parent
already did and what could not be undone).

Hackathon target: one recorded run on a seed repo with a planted injection; scrub to the flagged
step; investigate fork shows the clean branch never makes the egress call; recover fork resumes
with the ledger.

## Verified facts about OpenCode 1.18.33

Tested live on 2026-09-28 against `opencode serve` with an OpenRouter model. Fixture:
`artifacts/api-server/test/fixtures/opencode_events.jsonl` (captured `/event` stream of one tool-using run).

- Every model call is its own assistant message whose `parentID` is the user message. Parts:
  `step-start`, `reasoning` / `text`, one `tool` part per call (call and result in one part),
  `step-finish` (`reason`, `cost`, `tokens`). OpenCode's message boundary therefore equals
  Rewind's `valid_boundary` round.
- Tool part events (`message.part.updated`): `pending` -> `running` (repeated while bash output
  streams) -> `completed` with `output`, `metadata`, `title` (or `error`).
- `POST /session/:id/fork {messageID}` copies every message *before* `messageID` into a new
  session with fresh message and part ids.
- `POST /session/:id/revert {messageID, partID?}` is staged: nothing is deleted until the next
  prompt, at which point the message is cut *before* `partID` and later messages are dropped.
  Without `partID` the revert snaps to the owning user message.
- `POST /session/:id/message {parts: []}` continues a session; it inserts an empty user message.
- `"snapshot": false` in `opencode.json` stops OpenCode from writing snapshots or restoring files.
- Plugin hooks (`@opencode-ai/plugin` 1.18.33): `tool.execute.before(input{tool,sessionID,callID},
  output{args})` blocks by throwing; `tool.execute.after(input{tool,sessionID,callID,args},
  output{title,output,metadata})` may mutate `output.output`, and the model sees the mutation
  (raw streamed bash chunks are still persisted in OpenCode's local `opencode.db`);
  `experimental.chat.messages.transform(input, output{messages})` mutates the exact message array
  sent to the provider.
- Session data lives in `~/.local/share/opencode/opencode.db` (SQLite). Not used by this design.

## Architecture

One new source of steps beside the existing loop. Nothing in `artifacts/api-server/src/lib/loop.ts` changes.

```
opencode serve (per project dir)  --/event SSE-->  artifacts/api-server/src/lib/opencode/recorder.ts  --> steps rows
        ^                                                  |
        |  fork / revert / message (HTTP)                  | after each mutating tool: commit to
        |                                                  | data/snapshots/<session> (GIT_DIR)
artifacts/api-server/src/lib/opencode/session.ts  <-- fork endpoint             v
                                                   artifacts/api-server/src/lib/security/classify.ts (rules + Jev)
                                                           |
                                                           v
                                                   steps.classification -> SSE -> frontend flags
```

### Runner

- `branches.runner` (`rewind` | `opencode`, default `rewind`), `branches.oc_session_id`,
  `branches.project_dir`.
- `steps.oc_message_id`, `steps.oc_part_id`, `steps.classification` (JSONB, nullable).
- Columns in `lib/db/src/schema/rewind.ts` plus `add column if not exists` statements in `artifacts/api-server/src/lib/migrate.ts`.

### Recorder (`artifacts/api-server/src/lib/opencode/recorder.ts`)

- `translate(events) -> steps`: a pure function over the event stream. Terminal-state rule:
  `message.updated` for a user message -> `user` step; tool part `running` -> `tool_call` step;
  tool part `completed`/`error` -> `tool_result` step; `step-finish` -> `assistant` step carrying
  the accumulated text, the `tool_calls` list synthesised from the round's tool parts, and the
  tokens. Every step carries `oc_message_id` and `oc_part_id`.
- `content` is an OpenAI-style message dict so `messages_from_steps` and the UI work unchanged.
  `tool_calls[i].id` is the OpenCode `callID`; `tool_result.content.tool_call_id` matches it.
- Snapshots: after every completed `edit`, `write`, `bash` (and any tool that leaves the tree
  dirty) the recorder commits the project tree with `GIT_DIR=<data_dir>/snapshots/<oc_session_id>`
  and `GIT_WORK_TREE=<project_dir>`. `commit_hash` and `files_changed` are filled as today; the
  project's own `.git` is never touched. On session idle the store is bundled like a finished
  branch.
- `session.idle` -> branch status `done`; `session.error` -> `failed`.
- Subagent child sessions are not followed: a `task` tool part becomes an opaque tool step.
- Compaction: recorded sessions run with `compaction.auto: false`; a `session.compacted` event,
  if it ever arrives, is recorded as a `note` on the next step.

### Classifier (`artifacts/api-server/src/lib/security/classify.ts`)

Input: a `tool_call` + `tool_result` pair rendered as a fenced state string
(tool name, argument summary, result truncated to 24k characters).

1. Rules (deterministic, always run):
   - egress: `curl|wget|nc|ssh|scp|pip install|npm install|npx` or any URL in a `bash` command;
   - secrets: paths matching `.env`, `id_rsa`, `*.pem`, `credentials`, `.aws`, `.ssh`, `.npmrc`;
   - escape: any path resolving outside `project_dir`;
   - instruction phrases in results: `ignore (all )?previous`, `you must now`, `do not mention`,
     `note to (the )?(ai|assistant|agent)`.
2. Jev via OpenRouter `POST /api/alpha/decisions`, model `typesafe/jev-1.13`, three questions:
   `injection` (noul), `effect` (choice: pure / reversible_local / external / unknown, options
   shuffled per call), `severity` (score 0..4). One call, ~470 ms, ~$0.00002.
3. Verdict: `flagged = injection > 0.5 or severity >= 3 or rules`. Stored:
   `{"flag": bool, "reasons": [enum...], "injection": p, "effect": str, "effect_conf": p,
   "severity": x, "source": "posthoc"|"inline"}`. Model output is never stored as text.

Modes:
- post-hoc (default): fire-and-forget task after each `tool_result` step; publishes a
  `classification` SSE event.
- inline (`REWIND_INLINE_GUARD=1`): the OpenCode plugin `.opencode/plugins/rewind.ts` (at the workspace root) calls
  `POST /api/classify` from `tool.execute.before` (throw on `flag` for effectful tools) and
  `tool.execute.after` (replace a flagged result with `[rewind] result withheld: <reasons>` and
  tag the step). Only `bash`, `webfetch`, MCP tools and results over 2k characters are sent;
  everything else is rules-only, so the latency lands only on calls that can do damage.

Jev is behind a `Classifier` interface with a fake implementation for tests, mirroring
`artifacts/api-server/src/lib/client.ts`.

### Fork (`artifacts/api-server/src/lib/opencode/session.ts`, extends `POST /branches/:id/fork`)

Request gains `mode: "investigate" | "recover"` (OpenCode branches only).

Common: resolve the Rewind boundary with `valid_boundary`; `oc_fork_id = fork(next round's
message id)`; restore Rewind snapshot `commit_hash` at the boundary into `project_dir`
(`git --git-dir=... --work-tree=... checkout <hash> -- .` plus removal of files not in the tree);
create the child branch with the inherited steps, as `create_forks` does today.

- investigate: `POST /session/<fork>/message {parts: []}`. Same context minus the tail; the one
  known difference is the empty user message, shown in the UI as a note on the fork.
- recover: if the boundary is mid-round, `revert {messageID, partID}` first; then send the ledger
  as the prompt.

Ledger (`artifacts/api-server/src/lib/security/ledger.ts`), built from the parent's steps after the boundary:

```
## Rewound
You were rewound to step N. Reason: <flag reasons of the first flagged step, as enum text>.
## Reverted (files restored to step N)
- <path> (steps 14, 16)
## Persistent (could not be reverted)
- run: curl POST api.example.com/upload  -> exit 0    (step 15)
## Reusable work from before the flagged step
- commit <hash>: <files>   (its diff is available in Rewind; not applied automatically)
```

Every field is derived from structured step data (tool name, argument summary, effect enum,
commit hash, file list). No free text from tool results or from the classifier is ever included;
a flagged step contributes only its reason enums.

### UI

- `Scrubber`: red marker on flagged steps, amber on `external` effects below the flag threshold.
- `StepCard`: badge with the reasons; `ContextDrawer`: classification panel with the three numbers.
- `ForkPopover`: "Investigate (blind)" and "Recover (with ledger)" for OpenCode branches.
- `NewSessionForm`: runner selector; OpenCode runner takes a project path and a prompt and
  starts `opencode serve` for that path if none is registered.

### Configuration

`OPENCODE_BIN` (default `opencode`), `OPENCODE_PORT_BASE` (default 4096), `JEV_MODEL`
(default `typesafe/jev-1.13`), `REWIND_INLINE_GUARD` (default off), `CLASSIFY_MAX_CHARS`
(default 24000). Jev uses the existing `OPENROUTER_API_KEY`.

### Error handling

- Jev unreachable or malformed: classification `{"flag": false, "reasons": ["classifier_error"]}`
  from the model half; rules still apply. Shown on the timeline as a grey marker.
- OpenCode server down: branch `failed` with the HTTP error; recorder reconnects to `/event`
  with backoff while the branch is `running`.
- Fork on a branch whose snapshot store is missing: 409 with a message.

### Testing

- `translate()` against the captured fixture: step kinds, order, ids, token totals, and that
  `messages_from_steps` of the result is a valid chat array.
- Rules with a table of commands and paths; verdict logic with a fake Jev.
- Ledger rendering from a synthetic parent branch, including the redaction property (a flagged
  step's result text never appears in the ledger).
- Fork boundary mapping: Rewind index -> OpenCode message id / part id.
- `OPENCODE_E2E=1`: one test drives a real `opencode serve` on the csv-stats seed with the
  planted-injection variant, asserts a flag appears and an investigate fork is created.

### Out of scope

Claude Code hooks, CLM, database snapshots, subagent branches, reading `opencode.db`,
exact-wire-context capture via `experimental.chat.messages.transform` (noted as the follow-up
that would restore the fidelity the built-in loop has).
