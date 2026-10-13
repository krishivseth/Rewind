/** In-process pubsub keyed by branch id. */
export interface BranchEvent { type: "step" | "status"; data: Record<string, unknown> }
type Listener = (event: BranchEvent) => void;
const subs = new Map<string, Set<Listener>>();

export function subscribe(branchId: string, fn: Listener): () => void {
  const set = subs.get(branchId) ?? new Set<Listener>();
  set.add(fn);
  subs.set(branchId, set);
  return () => { set.delete(fn); if (!set.size) subs.delete(branchId); };
}

export function publish(branchId: string, event: BranchEvent): void {
  subs.get(branchId)?.forEach((fn) => { try { fn(event); } catch { /* listener error must not break the loop */ } });
}
