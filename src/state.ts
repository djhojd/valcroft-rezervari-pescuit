import type { Slot } from "./parser";

export type StoredSlot = { calId: string; date: string };

export type WatchedDate = {
  date: string;         // YYYY-MM-DD (Bucharest local date)
  snap15: StoredSlot[]; // slots at last 15-min tick; basis for edge diff
  countHourly: number;  // slot count at last :00 tick; basis for decrease detection
  snapDaily: Slot[];    // slots at last 19:00 tick; basis for daily report diff
};

function isWatchedDate(x: unknown): x is WatchedDate {
  if (!x || typeof x !== "object") return false;
  const w = x as Record<string, unknown>;
  return typeof w.date === "string"
    && Array.isArray(w.snap15)
    && typeof w.countHourly === "number";
}

function normalize(entry: Partial<WatchedDate> & { date: string; snap15: StoredSlot[]; countHourly: number }): WatchedDate {
  return {
    date: entry.date,
    snap15: entry.snap15,
    countHourly: entry.countHourly,
    snapDaily: Array.isArray(entry.snapDaily) ? entry.snapDaily : [],
  };
}

export async function readWatched(kv: KVNamespace): Promise<WatchedDate[]> {
  try {
    const raw = await kv.get("watched", "json");
    if (Array.isArray(raw)) {
      return raw.filter(isWatchedDate).map((e) => normalize(e));
    }
    if (isWatchedDate(raw)) {
      // Legacy single-object record from the pre-multi-date version. Wrap as a one-entry list.
      return [normalize(raw)];
    }
    return [];
  } catch {
    return [];
  }
}

export async function writeWatched(kv: KVNamespace, list: WatchedDate[]): Promise<void> {
  await kv.put("watched", JSON.stringify(list));
}

export async function addWatchedDate(kv: KVNamespace, entry: WatchedDate): Promise<boolean> {
  const list = await readWatched(kv);
  if (list.some((w) => w.date === entry.date)) return false;
  list.push(entry);
  await writeWatched(kv, list);
  return true;
}

export async function removeWatchedDate(kv: KVNamespace, date: string): Promise<boolean> {
  const list = await readWatched(kv);
  const next = list.filter((w) => w.date !== date);
  if (next.length === list.length) return false;
  await writeWatched(kv, next);
  return true;
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
