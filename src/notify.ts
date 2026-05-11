import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext/browser";
import type { Slot } from "./parser";

export type NotifyEnv = {
  EMAIL: SendEmail;
  SENDER_EMAIL: string;
  PAGE_URL: string;
};

type SendResult = { recipient: string; ok: boolean; error?: string };

const RO_WEEKDAY = ["dum", "lun", "mar", "mie", "joi", "vin", "sâm"];
const RO_MONTH_SHORT = ["ian", "feb", "mar", "apr", "mai", "iun", "iul", "aug", "sep", "oct", "noi", "dec"];
const RO_MONTH_LONG  = ["ianuarie", "februarie", "martie", "aprilie", "mai", "iunie",
                        "iulie", "august", "septembrie", "octombrie", "noiembrie", "decembrie"];

function formatSlotDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${RO_WEEKDAY[wd]} ${d} ${RO_MONTH_SHORT[m - 1]}`;
}

export function formatDateLong(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const weekdays = ["duminică", "luni", "marți", "miercuri", "joi", "vineri", "sâmbătă"];
  return `${weekdays[wd]}, ${d} ${RO_MONTH_LONG[m - 1]} ${y}`;
}

function buildSlotList(slots: Slot[], pageUrl: string): string {
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
  const items = sortedPontoons
    .map((p) => {
      const dates = groups.get(p)!.sort().map(formatSlotDate).join(", ");
      return `<li><strong>${p}</strong> — ${dates}</li>`;
    })
    .join("");
  return `<ul>${items}</ul><p><a href="${pageUrl}">Rezervă acum</a></p>`;
}

async function sendEmailToAll(
  subject: string,
  html: string,
  recipients: string[],
  env: NotifyEnv
): Promise<SendResult[]> {
  const results: SendResult[] = [];
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

/** Sent immediately when user registers a watched date. Lists all current free slots. */
export async function sendInitialEmail(
  date: string,
  slots: Slot[],
  intervalMinutes: number,
  recipients: string[],
  env: NotifyEnv
): Promise<SendResult[]> {
  const dateLabel = formatDateLong(date);
  const count = slots.length;
  const subject = `Valcroft: urmărire activată pentru ${formatSlotDate(date)} — ${count} ${count === 1 ? "loc liber" : "locuri libere"}`;
  const intervalNote = `<p>Verificare automată la fiecare <strong>${intervalMinutes} minute</strong>. Vei fi notificat doar când apar locuri noi.</p>`;
  const body = count === 0
    ? `<p>Niciun loc disponibil momentan pe <strong>${dateLabel}</strong>.</p>${intervalNote}<p><a href="${env.PAGE_URL}">Vezi calendarul</a></p>`
    : `<p>Locuri disponibile pe <strong>${dateLabel}</strong>:</p>${buildSlotList(slots, env.PAGE_URL)}${intervalNote}`;
  return sendEmailToAll(subject, body, recipients, env);
}

/** Sent every 15 min when new slots have opened since last check. */
export async function sendNewSlotsEmail(
  date: string,
  newSlots: Slot[],
  recipients: string[],
  env: NotifyEnv
): Promise<SendResult[]> {
  const count = newSlots.length;
  const subject = `Valcroft: ${count} ${count === 1 ? "loc nou" : "locuri noi"} pe ${formatSlotDate(date)}`;
  const body = `<p>Locuri noi disponibile pe <strong>${formatDateLong(date)}</strong>:</p>${buildSlotList(newSlots, env.PAGE_URL)}`;
  return sendEmailToAll(subject, body, recipients, env);
}

/** Sent every hour when the total free count has decreased since the previous hour. */
export async function sendOccupancyEmail(
  date: string,
  remaining: number,
  taken: number,
  recipients: string[],
  env: NotifyEnv
): Promise<SendResult[]> {
  const subject = `Valcroft: ${remaining} ${remaining === 1 ? "loc rămas" : "locuri rămase"} pe ${formatSlotDate(date)}`;
  const body = `<p>Pe <strong>${formatDateLong(date)}</strong>: <strong>${remaining}</strong> ${remaining === 1 ? "loc liber" : "locuri libere"} rămase.</p>
<p>${taken} ${taken === 1 ? "a fost rezervat" : "au fost rezervate"} în ultima oră.</p>
<p><a href="${env.PAGE_URL}">Rezervă acum</a></p>`;
  return sendEmailToAll(subject, body, recipients, env);
}

/** Sent when the user manually stops the watch via the UI. */
export async function sendManualStopEmail(
  date: string,
  recipients: string[],
  env: NotifyEnv
): Promise<SendResult[]> {
  const subject = `Valcroft: urmărire oprită pentru ${formatSlotDate(date)}`;
  const body = `<p>Urmărirea pentru <strong>${formatDateLong(date)}</strong> a fost oprită manual.</p>
<p><a href="${env.PAGE_URL}">Vezi calendarul</a></p>`;
  return sendEmailToAll(subject, body, recipients, env);
}

/** Sent when the watch auto-expires at 07:00 on the watched date. */
export async function sendExpiryEmail(
  date: string,
  recipients: string[],
  env: NotifyEnv
): Promise<SendResult[]> {
  const subject = `Valcroft: urmărire încheiată pentru ${formatSlotDate(date)}`;
  const body = `<p>Urmărirea pentru <strong>${formatDateLong(date)}</strong> a fost oprită automat la 07:00 — fereastra de anulare a rezervărilor s-a închis.</p>
<p><a href="${env.PAGE_URL}">Vezi calendarul</a></p>`;
  return sendEmailToAll(subject, body, recipients, env);
}

/** Sent daily at 19:00 Bucharest. Summarises slots opened/booked in the last 24h. */
export async function sendDailyReportEmail(
  date: string,
  added: Slot[],
  booked: Slot[],
  currentTotal: number,
  isFirst: boolean,
  recipients: string[],
  env: NotifyEnv
): Promise<SendResult[]> {
  const dateLabel = formatDateLong(date);
  const calendarLink = `<p><a href="${env.PAGE_URL}">Vezi calendarul</a></p>`;

  if (isFirst) {
    const subject = `Valcroft: urmărire pornită pentru ${formatSlotDate(date)} — ${currentTotal} ${currentTotal === 1 ? "loc liber" : "locuri libere"}`;
    const body = currentTotal === 0
      ? `<p>Urmărire pornită pentru <strong>${dateLabel}</strong>. Niciun loc liber momentan.</p>${calendarLink}`
      : `<p>Urmărire pornită pentru <strong>${dateLabel}</strong>. Situație curentă:</p>${buildSlotList(added, env.PAGE_URL)}`;
    return sendEmailToAll(subject, body, recipients, env);
  }

  const subject = `Valcroft: raport zilnic pentru ${formatSlotDate(date)} — +${added.length} / -${booked.length}`;

  if (added.length === 0 && booked.length === 0) {
    const body = `<p>Nicio modificare în ultimele 24 de ore pentru <strong>${dateLabel}</strong>.</p>
<p><strong>${currentTotal}</strong> ${currentTotal === 1 ? "loc liber" : "locuri libere"} acum.</p>${calendarLink}`;
    return sendEmailToAll(subject, body, recipients, env);
  }

  const addedSection = added.length > 0
    ? `<p><strong>Locuri eliberate (${added.length}):</strong></p>${buildSlotList(added, env.PAGE_URL)}`
    : "";
  const bookedSection = booked.length > 0
    ? `<p><strong>Locuri rezervate (${booked.length}):</strong></p>${buildSlotList(booked, env.PAGE_URL)}`
    : "";
  const totalLine = `<p><strong>${currentTotal}</strong> ${currentTotal === 1 ? "loc liber" : "locuri libere"} acum pe <strong>${dateLabel}</strong>.</p>`;
  const body = `${addedSection}${bookedSection}${totalLine}${calendarLink}`;
  return sendEmailToAll(subject, body, recipients, env);
}
