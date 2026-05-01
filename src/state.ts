import type { Slot } from "./parser";

export type StoredSlot = { calId: string; date: string };

export async function readSnapshot(kv: KVNamespace): Promise<StoredSlot[]> {
  const raw = await kv.get("snapshot", "json");
  return Array.isArray(raw) ? (raw as StoredSlot[]) : [];
}

export async function writeSnapshot(kv: KVNamespace, slots: Slot[]): Promise<void> {
  const payload: StoredSlot[] = slots.map((s) => ({ calId: s.calId, date: s.date }));
  await kv.put("snapshot", JSON.stringify(payload));
}

export async function readRecipients(kv: KVNamespace): Promise<string[]> {
  const raw = await kv.get("recipients", "json");
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  return [];
}

export function diffSlots(current: Slot[], previous: StoredSlot[]): Slot[] {
  const seen = new Set(previous.map((s) => `${s.calId}:${s.date}`));
  return current.filter((s) => !seen.has(`${s.calId}:${s.date}`));
}
