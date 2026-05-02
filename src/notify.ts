import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext/browser";
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
