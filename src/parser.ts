export type Slot = { calId: string; pontoon: string; date: string };

// Cells outside the rendered month are shown by the calendar but their booked
// state is not rendered reliably, so they are never treated as available.
const UNAVAILABLE_CLASSES = ["booked", "prev-date", "prev-month", "next-month"];

function normalizeDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

export async function parseAvailability(html: string): Promise<Slot[]> {
  const slots: Slot[] = [];
  const seen = new Set<string>();

  let lastPontoonLabel: string | null = null;
  let pBuf = "";
  let currentCalId: string | null = null;
  let currentPontoon: string | null = null;

  const rewriter = new HTMLRewriter()
    .on("p", {
      element() {
        pBuf = "";
      },
      text(t) {
        pBuf += t.text;
        if (t.lastInTextNode) {
          const m = pBuf.trim().match(/^Ponton\s+\d+/i);
          if (m) lastPontoonLabel = m[0];
          pBuf = "";
        }
      },
    })

    .on("table[data-calendar-id]", {
      element(el) {
        currentCalId = el.getAttribute("data-calendar-id");
        currentPontoon = lastPontoonLabel;
      },
    })

    .on("table[data-calendar-id] td[data-date]", {
      element(el) {
        if (!currentCalId || !currentPontoon) return;

        const cls = (el.getAttribute("class") || "").trim();
        const classes = cls ? cls.split(/\s+/) : [];
        if (classes.some((c) => UNAVAILABLE_CLASSES.includes(c))) return;

        const date = normalizeDate(el.getAttribute("data-date") || "");
        if (!date) return;

        const key = `${currentCalId}:${date}`;
        if (seen.has(key)) return;
        seen.add(key);
        slots.push({ calId: currentCalId, pontoon: currentPontoon, date });
      },
    });

  await rewriter.transform(new Response(html)).text();
  return slots;
}
