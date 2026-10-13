/** The boot migration must upgrade a database left by the previous schema, nulls and extra tables included. */
import "./setup";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { migrate } from "../src/lib/migrate";
import { closeDb } from "./support";

after(async () => { await closeDb(); });

test("migrate upgrades the previous schema in place", async () => {
  await db.execute(sql.raw(`drop table if exists steps, branches, sessions, repos, bundle_cleanup_queue, bundle_upload_intents, cleanup_monitor_state cascade`));
  await db.execute(sql.raw(`drop type if exists branch_status, step_kind cascade`));
  // the schema this repo had before the rewrite
  await db.execute(sql.raw(`create type branch_status as enum ('queued','running','done','failed','cancelled')`));
  await db.execute(sql.raw(`create type step_kind as enum ('user','assistant','tool_call','tool_result')`));
  await db.execute(sql.raw(`create table repos (id uuid primary key default gen_random_uuid(), slug text not null unique, name text not null, description text not null default '', bundle_key text, created_at timestamptz not null default now())`));
  await db.execute(sql.raw(`create table sessions (id uuid primary key default gen_random_uuid(), user_id text, repo_id uuid not null references repos(id), title text not null, created_at timestamptz not null default now(), expires_at timestamptz not null default now() + interval '30 days', deleted_at timestamptz)`));
  await db.execute(sql.raw(`create table branches (id uuid primary key default gen_random_uuid(), session_id uuid not null references sessions(id), parent_branch_id uuid, fork_step_index integer, model_id text not null, system_prompt text not null default '', task_prompt text not null, status branch_status not null default 'queued', step_count integer not null default 0, total_input_tokens integer not null default 0, total_output_tokens integer not null default 0, bundle_key text, lease_expires_at timestamptz, created_at timestamptz not null default now(), finished_at timestamptz)`));
  await db.execute(sql.raw(`create table steps (id uuid primary key default gen_random_uuid(), branch_id uuid not null references branches(id), "index" integer not null, kind step_kind not null, content jsonb not null, tool_name text, tool_args jsonb, tool_result text, commit_hash text, files_changed jsonb not null default '[]', input_tokens integer, output_tokens integer, latency_ms integer, created_at timestamptz not null default now())`));
  await db.execute(sql.raw(`create table cleanup_monitor_state (id text primary key, active_reasons jsonb not null default '[]', health_unavailable boolean not null default false, updated_at timestamptz not null default now())`));
  await db.execute(sql.raw(`create table bundle_upload_intents (bundle_key text primary key, expires_at timestamptz not null, created_at timestamptz not null default now())`));
  await db.execute(sql.raw(`insert into repos (slug, name) values ('csv-stats', 'csv-stats')`));
  await db.execute(sql.raw(`insert into sessions (repo_id, title) select id, 'old' from repos`));
  await db.execute(sql.raw(`insert into branches (session_id, model_id, task_prompt, status) select id, 'm', 't', 'done' from sessions`));
  await db.execute(sql.raw(`insert into steps (branch_id, "index", kind, content) select id, 0, 'user', '{"role":"user","content":"t"}' from branches`));
  await db.execute(sql.raw(`insert into steps (branch_id, "index", kind, content, tool_name) select id, 1, 'tool_call', '{}', 'read_file' from branches`));

  await migrate();
  await migrate(); // idempotent

  const cols = await db.execute(sql.raw(`select column_name, is_nullable from information_schema.columns where table_name in ('steps','branches','sessions') and column_name in ('note','error','created_by','root_branch_id','input_tokens','expires_at') order by column_name`));
  const byName = Object.fromEntries((cols.rows as Array<{ column_name: string; is_nullable: string }>).map((r) => [r.column_name, r.is_nullable]));
  assert.deepEqual(Object.keys(byName).sort(), ["created_by", "error", "expires_at", "input_tokens", "note", "root_branch_id"]);
  assert.equal(byName.input_tokens, "NO");
  assert.equal(byName.expires_at, "YES");
  const nulls = await db.execute(sql.raw(`select count(*)::int as n from steps where input_tokens is null or output_tokens is null or latency_ms is null`));
  assert.equal((nulls.rows[0] as { n: number }).n, 0);
  const idx = await db.execute(sql.raw(`select indexname from pg_indexes where tablename='steps' and indexname='steps_branch_index_uq'`));
  assert.equal(idx.rows.length, 1);
  await db.execute(sql.raw(`drop table if exists cleanup_monitor_state, bundle_upload_intents`));
});
