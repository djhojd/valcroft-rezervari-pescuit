import type { WatchedState } from "./state";
import { formatDateLong } from "./notify";

function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function renderWatchPage(watched: WatchedState | null, path: string): string {
  if (watched) {
    return `<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Valcroft — Urmărire disponibilitate</title>
  <style>
    body { font-family: sans-serif; max-width: 480px; margin: 2rem auto; padding: 0 1rem; }
    button { padding: .5rem 1.2rem; font-size: 1rem; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Valcroft — Urmărire disponibilitate</h1>
  <p>Urmărești: <strong>${formatDateLong(watched.date)}</strong><br>
  Verificare la fiecare 15 minute, până la 07:00 în acea zi.</p>
  <form method="POST" action="${path}">
    <button type="submit" name="action" value="stop" style="background:#c0392b;color:#fff">Oprește urmărirea</button>
  </form>
</body>
</html>`;
  }

  return `<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Valcroft — Urmărire disponibilitate</title>
  <style>
    body { font-family: sans-serif; max-width: 480px; margin: 2rem auto; padding: 0 1rem; }
    label { display: block; margin-bottom: .5rem; }
    input[type=date] { font-size: 1rem; padding: .3rem; margin-top: .25rem; }
    button { padding: .5rem 1.2rem; font-size: 1rem; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Valcroft — Urmărire disponibilitate</h1>
  <p>Nicio dată urmărită momentan.</p>
  <form method="POST" action="${path}">
    <label>Alege o dată:
      <input type="date" name="date" value="${tomorrow()}" required>
    </label><br><br>
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
  <meta http-equiv="refresh" content="2;url=${path}">
  <title>Valcroft</title>
  <style>body{font-family:sans-serif;max-width:480px;margin:2rem auto;padding:0 1rem}</style>
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
  <title>Valcroft — Eroare</title>
  <style>body{font-family:sans-serif;max-width:480px;margin:2rem auto;padding:0 1rem}p{color:#c0392b}</style>
</head>
<body>
  <h1>Eroare</h1>
  <p>${message}</p>
  <p><a href="${path}">Înapoi</a></p>
</body>
</html>`;
}
