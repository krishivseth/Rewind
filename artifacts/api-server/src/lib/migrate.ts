/**
 * Idempotent boot-time migration. `drizzle-kit push` prompts on anything destructive and cannot run
 * unattended against a database that has the older schema, so the server brings the tables up to
 * date itself: create-if-missing, add-column-if-missing, backfill nulls, then constraints.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

const statements = [
  `do $$ begin create type branch_status as enum ('queued','running','done','failed','cancelled'); exception when duplicate_object then null; end $$`,
  `do $$ begin create type step_kind as enum ('user','assistant','tool_call','tool_result'); exception when duplicate_object then null; end $$`,
  `create table if not exists repos (id uuid primary key default gen_random_uuid(), slug text not null unique, name text not null, description text not null default '', bundle_key text, created_at timestamptz not null default now())`,
  `create table if not exists sessions (id uuid primary key default gen_random_uuid(), user_id text, repo_id uuid not null references repos(id), title text not null, root_branch_id uuid, created_at timestamptz not null default now(), expires_at timestamptz, deleted_at timestamptz)`,
  `create table if not exists branches (id uuid primary key default gen_random_uuid(), session_id uuid not null references sessions(id), parent_branch_id uuid, fork_step_index integer, model_id text not null, system_prompt text not null default '', task_prompt text not null, status branch_status not null default 'queued', error text, step_count integer not null default 0, total_input_tokens integer not null default 0, total_output_tokens integer not null default 0, bundle_key text, created_by text, lease_expires_at timestamptz, created_at timestamptz not null default now(), finished_at timestamptz)`,
  `create table if not exists steps (id uuid primary key default gen_random_uuid(), branch_id uuid not null references branches(id), "index" integer not null, kind step_kind not null, content jsonb not null, tool_name text, tool_args jsonb, tool_result text, commit_hash text, files_changed jsonb not null default '[]', input_tokens integer not null default 0, output_tokens integer not null default 0, latency_ms integer not null default 0, note text, created_at timestamptz not null default now())`,
  `create table if not exists bundle_cleanup_queue (bundle_key text primary key, attempts integer not null default 0, last_attempt_at timestamptz, last_error text, created_at timestamptz not null default now())`,
  // columns added since the first schema
  `alter table sessions add column if not exists root_branch_id uuid`,
  `alter table sessions add column if not exists deleted_at timestamptz`,
  `alter table sessions add column if not exists expires_at timestamptz`,
  `alter table sessions alter column expires_at drop not null`,
  `alter table branches add column if not exists error text`,
  `alter table branches add column if not exists created_by text`,
  `alter table branches add column if not exists lease_expires_at timestamptz`,
  `alter table branches add column if not exists stop_reason text`,
  `alter table steps add column if not exists note text`,
  // old rows had nullable token columns
  `update steps set input_tokens = 0 where input_tokens is null`,
  `update steps set output_tokens = 0 where output_tokens is null`,
  `update steps set latency_ms = 0 where latency_ms is null`,
  `alter table steps alter column input_tokens set default 0, alter column input_tokens set not null`,
  `alter table steps alter column output_tokens set default 0, alter column output_tokens set not null`,
  `alter table steps alter column latency_ms set default 0, alter column latency_ms set not null`,
  `create index if not exists branches_session_idx on branches (session_id)`,
  `create index if not exists branches_status_idx on branches (status)`,
  `create index if not exists sessions_retention_idx on sessions (deleted_at, expires_at)`,
  // old rows may collide; only add the uniqueness guarantee when they do not
  `do $$ begin if not exists (select 1 from steps group by branch_id, "index" having count(*) > 1) then create unique index if not exists steps_branch_index_uq on steps (branch_id, "index"); end if; end $$`,
];

const LOCK_KEY = 7_364_919; // arbitrary, stable: two instances booting together take turns

export async function migrate(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEY})`);
    for (const s of statements) {
      try { await tx.execute(sql.raw(s)); }
      catch (e) { logger.error({ err: e, statement: s.slice(0, 80) }, "migration statement failed"); throw e; }
    }
  });
  logger.info("schema up to date");
}
