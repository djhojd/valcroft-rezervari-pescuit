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
