/** At most MAX_CONCURRENT_BRANCHES run at once; the rest wait in FIFO order. */
import type { ModelClient } from "./client";
import { settings } from "./config";
import { runBranch } from "./loop";

const waiting: string[] = [];
const running = new Set<string>();
const tasks = new Map<string, Promise<void>>();
const wakers: Array<() => void> = [];

export const queuePosition = (id: string): number | null => (waiting.includes(id) ? waiting.indexOf(id) + 1 : null);
export const isTracked = (id: string): boolean => tasks.has(id);

async function acquire(id: string): Promise<void> {
  waiting.push(id);
  while (running.size >= settings.maxConcurrentBranches || waiting[0] !== id) {
    await new Promise<void>((resolve) => wakers.push(resolve));
  }
  waiting.shift();
  running.add(id);
}

function release(id: string): void {
  running.delete(id);
  const w = wakers.splice(0);
  w.forEach((fn) => fn());
}

export function enqueue(branchId: string, client?: ModelClient): Promise<void> {
  const task = (async () => {
    await acquire(branchId);
    try { await runBranch(branchId, client); } finally { release(branchId); tasks.delete(branchId); }
  })();
  tasks.set(branchId, task);
  return task;
}

export async function waitAll(): Promise<void> {
  while (tasks.size) await Promise.allSettled([...tasks.values()]);
}
