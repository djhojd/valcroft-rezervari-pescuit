# Valcroft Availability Notifier Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A Cloudflare Worker that runs hourly, scrapes <https://valcroft.ro/rezervari-pescuit/>, and emails a fixed recipient list whenever a fishing-pontoon spot in the current week becomes newly available.

**Architecture:** Single Worker with a Cron Trigger. On each tick: fetch the page HTML, parse availability with HTMLRewriter, filter to the current week (Europe/Bucharest), diff against the previous snapshot stored in KV, send one email per recipient via the Cloudflare Email Workers `send_email` binding, then write the new snapshot.

**Tech Stack:** TypeScript · Cloudflare Workers · Wrangler · Workers KV · Email Workers (`cloudflare:email`) · `mimetext` · HTMLRewriter (built-in).

**Reference:** see the design doc at `docs/plans/2026-05-01-availability-notifier-design.md` for context and rationale. **Tests are deferred** — there is no automated test suite in v1; verification is manual via `wrangler dev --test-scheduled`. A follow-up plan will add tests once the happy path is working.

---

## Task 0: Bootstrap the project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `wrangler.jsonc`
- Create: `README.md`

**Step 1: Initialize the npm project and install dependencies**

Run:
```
npm init -y
npm install --save-dev wrangler typescript @cloudflare/workers-types
npm install mimetext
```

**Step 2: Replace `package.json` scripts block**

Edit `package.json` so the `scripts` field is:
```json
"scripts": {
  "dev": "wrangler dev --test-scheduled",
  "deploy": "wrangler deploy",
  "tail": "wrangler tail",
  "typecheck": "tsc --noEmit"
}
```
Also set `"type": "module"`.

**Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

**Step 4: Create `.gitignore`**

```
node_modules/
.wrangler/
.dev.vars
*.log
.DS_Store
.valcroft.html
```

**Step 5: Create skeleton `wrangler.jsonc`**

```jsonc
{
  "$schema": "https://unpkg.com/wrangler@latest/config-schema.json",
  "name": "valcroft-availability-notifier",
  "main": "src/worker.ts",
  "compatibility_date": "2026-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "triggers": {
    "crons": ["0 * * * *"]
  },
  "vars": {
    "PAGE_URL": "https://valcroft.ro/rezervari-pescuit/",
    "SENDER_EMAIL": "monitor@REPLACE-WITH-YOUR-DOMAIN"
  },
  "kv_namespaces": [
    { "binding": "KV", "id": "REPLACE_WITH_KV_ID" }
  ],
  "send_email": [
    { "name": "EMAIL", "destination_address": null }
  ]
}
```

**Step 6: Create stub `src/worker.ts` so the project compiles**

```ts
export default {
  async scheduled(_event: ScheduledEvent, _env: unknown, _ctx: ExecutionContext) {
    console.log("scheduled tick — not implemented yet");
  },
};
```

**Step 7: Create a minimal `README.md`** with a single section "Setup" listing the manual steps:
1. Enable Email Routing on a domain in your CF account, set `SENDER_EMAIL` in `wrangler.jsonc`.
2. Verify each personal address as an Email Routing destination address.
3. `wrangler kv namespace create KV` → paste the `id` into `wrangler.jsonc`.
4. `wrangler kv key put --binding=KV recipients '["you@example.com"]'`.
5. `npm run deploy`.

**Step 8: Verify it typechecks**

Run: `npm run typecheck`
Expected: exits 0 with no output.

**Step 9: Initialize git and commit**

Run:
```
git init
git add .
git commit -m "chore: bootstrap Cloudflare Worker project"
```

---

## Task 1: `src/week.ts` — current-week bounds in Europe/Bucharest

**Files:**
- Create: `src/week.ts`

**Step 1: Write the module**

```ts
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
```

`currentWeekDates` returns the seven `YYYY-MM-DD` strings of the current Monday→Sunday in Europe/Bucharest. It's pure, so the rest of the system can compare slot dates with simple string equality.

**Step 2: Smoke-check from a one-off script**

Add a tiny temporary `scratch.ts` at the repo root and `npx tsx scratch.ts`:
```ts
import { currentWeekDates } from "./src/week.ts";
console.log(currentWeekDates(new Date("2026-05-01T12:00:00Z")));
```
Expected: 7 dates, the first being `2026-04-27` (Monday) and the last `2026-05-03` (Sunday). Delete `scratch.ts` after.

**Step 3: Commit**

```
git add src/week.ts
git commit -m "feat: current-week dates in Europe/Bucharest"
```

---

## Task 2: `src/fetcher.ts` — HTML fetch with retry

**Files:**
- Create: `src/fetcher.ts`

**Step 1: Write the module**

```ts
const UA = "valcroft-availability-monitor/1.0 (+contact: djhojd)";

export async function fetchPage(url: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          "Accept-Language": "ro-RO,ro;q=0.9,en;q=0.8",
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      if (res.status >= 500) {
        lastErr = new Error(`upstream ${res.status}`);
      } else if (!res.ok) {
        throw new Error(`fetch failed: ${res.status}`);
      } else {
        return await res.text();
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error("fetch failed");
}
```

**Step 2: Commit**

```
git add src/fetcher.ts
git commit -m "feat: HTML fetcher with retry on 5xx"
```

---

## Task 3: `src/parser.ts` — HTMLRewriter pass for available slots

**Files:**
- Create: `src/parser.ts`

**Step 1: Write the module**

```ts
export type Slot = { calId: string; pontoon: string; date: string };

const RO_MONTHS: Record<string, number> = {
  ianuarie: 1, februarie: 2, martie: 3, aprilie: 4, mai: 5, iunie: 6,
  iulie: 7, august: 8, septembrie: 9, octombrie: 10, noiembrie: 11, decembrie: 12,
};

export async function parseAvailability(html: string): Promise<Slot[]> {
  const slots: Slot[] = [];

  // Tracked across the whole stream
  let lastPontoonLabel: string | null = null;

  // Tracked per <table>
  let inTable = false;
  let currentCalId: string | null = null;
  let currentPontoon: string | null = null;
  let currentMonth: number | null = null;
  let currentYear: number | null = null;
  let monthHeaderBuf = "";
  let inMonthHeader = false;

  // Tracked per <td>
  let inTd = false;
  let currentTdClasses: string[] = [];
  let currentTdSkipped = false;
  let dayBuf = "";
  let inDay = false;

  const isAvailable = (cls: string[]) =>
    !cls.includes("booked") && !cls.includes("prev-date") && !cls.includes("prev-month");

  const rewriter = new HTMLRewriter()
    // Track most recent "Ponton X" paragraph
    .on("p", {
      text(t) {
        if (!t.lastInTextNode) return;
        const txt = (t.text || "").trim();
        const m = txt.match(/^Ponton\s+\d+/i);
        if (m) lastPontoonLabel = m[0];
      },
    })

    // Each pontoon's calendar table
    .on("table[data-calendar-id]", {
      element(el) {
        inTable = true;
        currentCalId = el.getAttribute("data-calendar-id");
        currentPontoon = lastPontoonLabel;
        currentMonth = null;
        currentYear = null;
      },
    })

    // Month/year header (Booked plugin renders it inside the table thead)
    .on("table[data-calendar-id] .calendar-header", {
      element() { inMonthHeader = true; monthHeaderBuf = ""; },
      text(t) {
        if (inMonthHeader) monthHeaderBuf += t.text;
        if (t.lastInTextNode) {
          inMonthHeader = false;
          // Match "mai 2026" / "Mai 2026" / "MAI 2026"
          const m = monthHeaderBuf.toLowerCase().match(/([a-zăâîșț]+)\s+(\d{4})/);
          if (m && RO_MONTHS[m[1]]) {
            currentMonth = RO_MONTHS[m[1]];
            currentYear = parseInt(m[2], 10);
          }
        }
      },
    })

    // Day cells
    .on("table[data-calendar-id] td", {
      element(el) {
        inTd = true;
        const cls = (el.getAttribute("class") || "").trim();
        currentTdClasses = cls ? cls.split(/\s+/) : [];
        currentTdSkipped = !isAvailable(currentTdClasses);
        dayBuf = "";
      },
    })
    .on("table[data-calendar-id] td .date", {
      element() { inDay = true; dayBuf = ""; },
      text(t) {
        if (inDay) dayBuf += t.text;
        if (t.lastInTextNode) {
          inDay = false;
          if (
            !currentTdSkipped &&
            currentCalId &&
            currentPontoon &&
            currentMonth &&
            currentYear
          ) {
            const day = parseInt(dayBuf.trim(), 10);
            if (Number.isFinite(day)) {
              const date = `${currentYear}-${String(currentMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              slots.push({ calId: currentCalId, pontoon: currentPontoon, date });
            }
          }
        }
      },
    });

  await rewriter.transform(new Response(html)).text();
  return slots;
}
```

**Step 2: Smoke-check against the real page**

Save the page HTML once with `curl -s -o sample.html https://valcroft.ro/rezervari-pescuit/` and run a temporary `scratch.ts`:
```ts
import { readFileSync } from "node:fs";
import { parseAvailability } from "./src/parser.ts";
const html = readFileSync("sample.html", "utf8");
parseAvailability(html).then((s) => {
  console.log("slots:", s.length, s.slice(0, 5));
});
```
Run: `npx tsx scratch.ts`.
Expected: a non-empty list of `{ calId, pontoon: "Ponton N", date: "YYYY-MM-DD" }` for available cells. Delete `sample.html` and `scratch.ts`.

**Step 3: Commit**

```
git add src/parser.ts
git commit -m "feat: HTMLRewriter parser for Booked plugin availability"
```

---

## Task 4: `src/state.ts` — KV snapshot read/write and recipients

**Files:**
- Create: `src/state.ts`

**Step 1: Write the module**

```ts
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
```

**Step 2: Commit**

```
git add src/state.ts
git commit -m "feat: KV snapshot, recipients, and slot diff"
```

---

## Task 5: `src/notify.ts` — send one email per recipient

**Files:**
- Create: `src/notify.ts`

**Step 1: Write the module**

```ts
import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";
import type { Slot } from "./parser";

export type NotifyEnv = {
  EMAIL: SendEmail;
  SENDER_EMAIL: string;
  PAGE_URL: string;
};

const RO_WEEKDAY = ["dum", "lun", "mar", "mie", "joi", "vin", "sâm"];
const RO_MONTH_SHORT = ["ian", "feb", "mar", "apr", "mai", "iun", "iul", "aug", "sep", "oct", "noi", "dec"];

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${RO_WEEKDAY[wd]} ${d} ${RO_MONTH_SHORT[m - 1]}`;
}

function buildHtml(slots: Slot[], pageUrl: string): string {
  const groups = new Map<string, string[]>();
  for (const s of slots) {
    const arr = groups.get(s.pontoon) ?? [];
    arr.push(s.date);
    groups.set(s.pontoon, arr);
  }
  const sortedPontoons = [...groups.keys()].sort((a, b) => {
    const na = parseInt(a.replace(/\D+/g, ""), 10) || 0;
    const nb = parseInt(b.replace(/\D+/g, ""), 10) || 0;
    return na - nb;
  });
  const items = sortedPontoons.map((p) => {
    const dates = groups.get(p)!.sort().map(formatDate).join(", ");
    return `<li><strong>${p}</strong> — ${dates}</li>`;
  }).join("");
  return `<p>Locuri noi disponibile săptămâna aceasta:</p>
<ul>${items}</ul>
<p><a href="${pageUrl}">Rezervă acum</a></p>`;
}

export async function sendEmails(
  slots: Slot[],
  recipients: string[],
  env: NotifyEnv
): Promise<{ recipient: string; ok: boolean; error?: string }[]> {
  const subject = `Valcroft: ${slots.length} ${slots.length === 1 ? "loc nou" : "locuri noi"} săptămâna aceasta`;
  const html = buildHtml(slots, env.PAGE_URL);
  const results: { recipient: string; ok: boolean; error?: string }[] = [];

  for (const recipient of recipients) {
    try {
      const msg = createMimeMessage();
      msg.setSender({ name: "Valcroft Monitor", addr: env.SENDER_EMAIL });
      msg.setRecipient(recipient);
      msg.setSubject(subject);
      msg.addMessage({ contentType: "text/html", data: html });
      const message = new EmailMessage(env.SENDER_EMAIL, recipient, msg.asRaw());
      await env.EMAIL.send(message);
      results.push({ recipient, ok: true });
    } catch (e) {
      results.push({ recipient, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
```

**Step 2: Commit**

```
git add src/notify.ts
git commit -m "feat: per-recipient email via Email Workers binding"
```

---

## Task 6: `src/worker.ts` — orchestration

**Files:**
- Modify: `src/worker.ts` (replace stub from Task 0)

**Step 1: Replace the stub with the full handler**

```ts
import { fetchPage } from "./fetcher";
import { parseAvailability } from "./parser";
import { currentWeekDates } from "./week";
import { readSnapshot, writeSnapshot, readRecipients, diffSlots } from "./state";
import { sendEmails } from "./notify";

export type Env = {
  KV: KVNamespace;
  EMAIL: SendEmail;
  PAGE_URL: string;
  SENDER_EMAIL: string;
};

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(run(env));
  },
};

async function run(env: Env): Promise<void> {
  const startedAt = Date.now();
  let html: string;
  try {
    html = await fetchPage(env.PAGE_URL);
  } catch (e) {
    console.error("fetch failed:", e);
    return;
  }

  const allSlots = await parseAvailability(html);
  if (allSlots.length === 0) {
    console.error("parse yielded zero slots — site format may have changed; not touching KV");
    return;
  }
  const week = new Set(currentWeekDates(new Date()));
  const weekSlots = allSlots.filter((s) => week.has(s.date));
  console.log(`parsed=${allSlots.length} weekSlots=${weekSlots.length}`);

  const previous = await readSnapshot(env.KV);
  const newlyAvailable = diffSlots(weekSlots, previous);
  console.log(`previous=${previous.length} newly=${newlyAvailable.length}`);

  if (newlyAvailable.length === 0) {
    await writeSnapshot(env.KV, weekSlots);
    console.log(`done in ${Date.now() - startedAt}ms (no notification)`);
    return;
  }

  const recipients = await readRecipients(env.KV);
  if (recipients.length === 0) {
    console.error("no recipients in KV — skipping email; writing snapshot anyway");
    await writeSnapshot(env.KV, weekSlots);
    return;
  }

  const results = await sendEmails(newlyAvailable, recipients, {
    EMAIL: env.EMAIL,
    SENDER_EMAIL: env.SENDER_EMAIL,
    PAGE_URL: env.PAGE_URL,
  });
  for (const r of results) {
    if (r.ok) console.log(`sent: ${r.recipient}`);
    else console.error(`send failed: ${r.recipient}: ${r.error}`);
  }

  const allFailed = results.every((r) => !r.ok);
  if (allFailed) {
    console.error("all sends failed — not writing snapshot, will retry next tick");
    return;
  }
  await writeSnapshot(env.KV, weekSlots);
  console.log(`done in ${Date.now() - startedAt}ms (notified)`);
}
```

**Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: exits 0.

**Step 3: Commit**

```
git add src/worker.ts
git commit -m "feat: scheduled handler orchestration"
```

---

## Task 7: One-time CF setup (manual, outside the repo)

These steps cannot be automated from the plan; do them once in the dashboard / CLI before deploy.

**Step 1: Pick a sender domain on your CF account, enable Email Routing.**
Dashboard → the domain → **Email** → Email Routing → enable. Add a destination address (your personal email) and click the verification link. Repeat for each address in your fixed recipient list.

**Step 2: Set the real `SENDER_EMAIL` in `wrangler.jsonc`.** Anything like `monitor@<your-domain>` is fine — the local part need not be a real mailbox; the domain just needs Email Routing enabled.

**Step 3: Create the KV namespace and wire it into `wrangler.jsonc`.**

Run: `npx wrangler kv namespace create KV`
Copy the printed `id` and replace `REPLACE_WITH_KV_ID` in `wrangler.jsonc`.

**Step 4: Seed the recipients list.**

Run: `npx wrangler kv key put --binding=KV recipients '["you@example.com"]'`
(Use the form with `--remote` if you want this on the live namespace.)

**Step 5: Commit the wrangler edits.**

```
git add wrangler.jsonc
git commit -m "chore: wire KV namespace id and sender email"
```

---

## Task 8: Local end-to-end smoke test

**Step 1: Run the scheduled handler locally**

Run: `npm run dev`
In another shell: `curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"`
Expected log lines:
- `parsed=N weekSlots=M`
- `previous=0 newly=M` (first run)
- one `sent:` or `send failed:` line per recipient (in `--remote` mode against the real binding) or a Wrangler simulation log (in default local mode).

If the diff is non-empty and you don't want a real email yet, run `wrangler dev` without `--remote` so the email send is simulated.

**Step 2: Confirm the snapshot landed**

Run: `npx wrangler kv key get --binding=KV snapshot`
Expected: a JSON array of `{ calId, date }`. If you want to test the diff logic, delete it and re-run:
`npx wrangler kv key delete --binding=KV snapshot`

**Step 3: No commit unless `wrangler.jsonc` changed during testing.**

---

## Task 9: Deploy

**Step 1: Deploy**

Run: `npm run deploy`
Expected: Wrangler prints the Worker URL and confirms the cron trigger `0 * * * *`.

**Step 2: Tail logs to watch the first scheduled run**

Run: `npm run tail`
Wait for the next top-of-the-hour. Expected log lines as in Task 8.

**Step 3: If first hour produces a flood of "newly available" emails (cold-start expected), that's normal — the snapshot was empty, so every available slot in the current week looks new. Subsequent ticks should be quiet unless something actually changes.**

**Step 4: Commit any final config touches and push.**

```
git push -u origin main
```

---

## Follow-ups (out of scope for this plan)

1. **Tests.** Add Vitest with `@cloudflare/vitest-pool-workers`. Cover: `currentWeekDates` boundaries (DST, year rollover), `parseAvailability` against a saved fixture, `diffSlots` semantics, `sendEmails` with a mocked `EMAIL` binding.
2. **Multi-week monitoring.** Add a `WEEKS_AHEAD` var and a second fetch with the Booked plugin's `?date=YYYY-MM` query string when the current week spans two months.
3. **Pause control via KV.** Read `paused` flag from KV; skip notify if true.
4. **Per-pontoon filtering.** KV `watched_calIds` to subscribe to only specific pontoons.
