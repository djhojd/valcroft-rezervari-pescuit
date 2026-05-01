const TZ = "Europe/Bucharest";

function localYMD(date: Date): { year: number; month: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const weekdayMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    weekday: weekdayMap[get("weekday")],
  };
}

function ymdToDateUTC(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

export function currentWeekDates(now: Date = new Date()): string[] {
  const today = localYMD(now);
  const todayUTC = ymdToDateUTC(today.year, today.month, today.day);
  const monOffset = today.weekday - 1; // 0 if Monday
  const monUTC = new Date(todayUTC.getTime() - monOffset * 86_400_000);
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monUTC.getTime() + i * 86_400_000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    out.push(`${y}-${m}-${day}`);
  }
  return out;
}
