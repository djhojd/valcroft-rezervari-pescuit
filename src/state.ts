import type { Slot } from "./parser";

export type StoredSlot = { calId: string; date: string };

export type WatchedState = {
  date: string;       // YYYY-MM-DD (Bucharest local date)
  snap15: StoredSlot[]; // slots at last 15-min tick; basis for edge diff
  countHourly: number;  // slot count at last :00 tick; basis for decrease detection
};

export async function readWatched(kv: KVNamespace): Promise<WatchedState | null> {
  try {
    const raw = await kv.get("watched", "json");
    if (raw && typeof (raw as WatchedState).date === "string") return raw as WatchedState;
    return null;
  } catch {
    return null;
  }
}

export async function writeWatched(kv: KVNamespace, state: WatchedState): Promise<void> {
  await kv.put("watched", JSON.stringify(state));
}

export async function clearWatched(kv: KVNamespace): Promise<void> {
  await kv.delete("watched");
}

export async function readRecipients(kv: KVNamespace): Promise<string[]> {
  try {
    const raw = await kv.get("recipients", "json");
    if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
    return [];
  } catch {
    return [];
  }
}

export function diffSlots(current: Slot[], previous: StoredSlot[]): Slot[] {
  const seen = new Set(previous.map((s) => `${s.calId}:${s.date}`));
  return current.filter((s) => !seen.has(`${s.calId}:${s.date}`));
}

export function slotsToStored(slots: Slot[]): StoredSlot[] {
  return slots.map((s) => ({ calId: s.calId, date: s.date }));
}
