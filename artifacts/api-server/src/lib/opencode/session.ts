/** Start recording an OpenCode session for a branch. */
import { eq } from "drizzle-orm";
import { branches, db } from "@workspace/db";
import { logger } from "../logger";
import { manager, writeOpencodeConfig, type OpenCodeClient } from "./client";
import { recordBranch } from "./recorder";
import { SnapshotStore } from "./snapshots";
import type { OcEvent } from "./translate";

const recorders = new Map<string, Promise<unknown>>();
export function runningRecorders(): Map<string, Promise<unknown>> { return recorders; }

/** Open the event stream before prompting so the first events are never missed. */
export async function openedStream(client: OpenCodeClient): Promise<AsyncIterable<OcEvent>> {
  const it = client.events()[Symbol.asyncIterator]();
  const first = await it.next();
  return {
    async *[Symbol.asyncIterator]() {
      if (!first.done) yield first.value;
      for (;;) { const n = await it.next(); if (n.done) return; yield n.value; }
    },
  };
}

export function track(branchId: string, run: () => Promise<unknown>): void {
  const p = run()
    .catch((e: unknown) => { logger.error({ err: e, branchId }, "opencode recorder failed"); })
    .finally(() => { recorders.delete(branchId); });
  recorders.set(branchId, p);
}

export async function startOpencodeBranch(branchId: string, client?: OpenCodeClient): Promise<void> {
  const [b] = await db.select().from(branches).where(eq(branches.id, branchId));
  if (!b?.projectDir) throw new Error("branch has no project_dir");
  await writeOpencodeConfig(b.projectDir, b.modelId);
  const oc = client ?? (await manager().ensure(b.projectDir));
  const ocId = await oc.createSession(`rewind ${branchId.slice(0, 8)}`);
  const store = new SnapshotStore(ocId, b.projectDir);
  await store.init();
  await db.update(branches).set({ ocSessionId: ocId, status: "running" }).where(eq(branches.id, branchId));
  const stream = await openedStream(oc);
  track(branchId, async () => {
    await oc.promptAsync(ocId, b.taskPrompt);
    await recordBranch(branchId, stream, store);
  });
}
