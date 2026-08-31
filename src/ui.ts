import type { WatchedDate } from "./state";
import { formatDateLong } from "./notify";

function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function renderWatchPage(list: WatchedDate[], path: string): string {
  const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));

  const watchedSection = sorted.length === 0
    ? `<p>Nicio dată urmărită momentan.</p>`
    : `<p>Date urmărite (verificare la fiecare 15 minute, până la 07:00 în acea zi):</p>
  <ul class="watched-list">
    ${sorted.map((w) => `
      <li>
        <strong>${formatDateLong(w.date)}</strong>
        <form method="POST" action="${path}" style="display:inline">
          <input type="hidden" name="action" value="stop">
          <input type="hidden" name="date" value="${w.date}">
          <button type="submit" style="background:#c0392b;color:#fff;margin-left:.5rem">Oprește</button>
        </form>
      </li>`).join("")}
  </ul>`;

  return `<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Valcroft — Urmărire disponibilitate</title>
  <style>
    body { font-family: sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
    label { display: block; margin-bottom: .5rem; }
    input[type=date] { font-size: 1rem; padding: .3rem; margin-top: .25rem; }
    button { padding: .4rem 1rem; font-size: 1rem; cursor: pointer; }
    .watched-list { list-style: none; padding: 0; }
    .watched-list li { padding: .4rem 0; border-bottom: 1px solid #eee; }
  </style>
</head>
<body>
  <h1>Valcroft — Urmărire disponibilitate</h1>
  ${watchedSection}
  <form method="POST" action="${path}" style="margin-top:1.5rem">
    <label>Adaugă o dată:
      <input type="date" name="date" value="${tomorrow()}" required>
    </label>
    <button type="submit" name="action" value="watch">Urmărește această dată</button>
  </form>
</body>
</html>`;
}

export function renderConfirmPage(message: string, path: string): string {
  return `<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="2;url=${path}">
  <title>Valcroft</title>
  <style>body{font-family:sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem}</style>
</head>
<body>
  <p>${message}</p>
  <p><small>Redirecționare automată în 2 secunde…</small></p>
  <p><a href="${path}">Înapoi</a></p>
</body>
</html>`;
}

export function renderErrorPage(message: string, path: string): string {
  return `<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Valcroft — Eroare</title>
  <style>body{font-family:sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem}p{color:#c0392b}</style>
</head>
<body>
  <h1>Eroare</h1>
  <p>${message}</p>
  <p><a href="${path}">Înapoi</a></p>
</body>
</html>`;
}
