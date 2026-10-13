import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const branchStatus = pgEnum("branch_status", ["queued", "running", "done", "failed", "cancelled"]);
export const stepKind = pgEnum("step_kind", ["user", "assistant", "tool_call", "tool_result"]);

export const repos = pgTable("repos", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  bundleKey: text("bundle_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  // kept from the earlier schema so `drizzle-kit push` stays additive; unused now (viewing is public)
  userId: text("user_id"),
  repoId: uuid("repo_id").notNull().references(() => repos.id),
  title: text("title").notNull(),
  rootBranchId: uuid("root_branch_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [index("sessions_retention_idx").on(table.deletedAt, table.expiresAt)]);

export const branches = pgTable("branches", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id),
  parentBranchId: uuid("parent_branch_id"),
  forkStepIndex: integer("fork_step_index"),
  modelId: text("model_id").notNull(),
  systemPrompt: text("system_prompt").notNull().default(""),
  taskPrompt: text("task_prompt").notNull(),
  status: branchStatus("status").notNull().default("queued"),
  error: text("error"),
  // why the run stopped: completed | call_limit | loop | token_budget | wall_clock | cancelled | provider_error | crash
  stopReason: text("stop_reason"),
  stepCount: integer("step_count").notNull().default(0),
  totalInputTokens: integer("total_input_tokens").notNull().default(0),
  totalOutputTokens: integer("total_output_tokens").notNull().default(0),
  bundleKey: text("bundle_key"),
  createdBy: text("created_by"),
  // renewed by the running process; a stale lease means the process died and the branch is failed on the next sweep
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (table) => [index("branches_session_idx").on(table.sessionId), index("branches_status_idx").on(table.status)]);

export const steps = pgTable("steps", {
  id: uuid("id").defaultRandom().primaryKey(),
  branchId: uuid("branch_id").notNull().references(() => branches.id),
  stepIndex: integer("index").notNull(),
  kind: stepKind("kind").notNull(),
  content: jsonb("content").$type<Record<string, unknown>>().notNull(),
  toolName: text("tool_name"),
  toolArgs: jsonb("tool_args").$type<Record<string, unknown> | null>(),
  toolResult: text("tool_result"),
  commitHash: text("commit_hash"),
  filesChanged: jsonb("files_changed").$type<string[]>().notNull().default([]),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("steps_branch_index_uq").on(table.branchId, table.stepIndex)]);

// Bundles of deleted sessions are removed here with retries, so a storage hiccup never leaks a bundle.
export const bundleCleanupQueue = pgTable("bundle_cleanup_queue", {
  bundleKey: text("bundle_key").primaryKey(),
  attempts: integer("attempts").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Repo = typeof repos.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Branch = typeof branches.$inferSelect;
export type Step = typeof steps.$inferSelect;
export type NewStep = typeof steps.$inferInsert;
