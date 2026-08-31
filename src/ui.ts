import type { WatchedDate } from "./state";
import { formatDateLong } from "./notify";

function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const STYLES = `
    :root {
      color-scheme: light;
      --bg: #fff;
      --fg: #1a1a1a;
      --muted: #666;
      --border: #eee;
      --danger: #c0392b;
      --danger-fg: #fff;
      --control-bg: #f7f7f7;
      --control-border: #ccc;
      --link: #0b57d0;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        color-scheme: dark;
        --bg: #161616;
        --fg: #e8e8e8;
        --muted: #a0a0a0;
        --border: #333;
        --danger: #e2665a;
        --danger-fg: #1a1a1a;
        --control-bg: #262626;
        --control-border: #4d4d4d;
        --link: #8ab4f8;
      }
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --bg: #161616;
      --fg: #e8e8e8;
      --muted: #a0a0a0;
      --border: #333;
      --danger: #e2665a;
      --danger-fg: #1a1a1a;
      --control-bg: #262626;
      --control-border: #4d4d4d;
      --link: #8ab4f8;
    }
    body {
      font-family: sans-serif;
      max-width: 640px;
      margin: 2rem auto;
      padding: 0 1rem;
      background: var(--bg);
      color: var(--fg);
    }
    a { color: var(--link); }
    small { color: var(--muted); }
    label { display: block; margin-bottom: .5rem; }
    input[type=date] {
      font-size: 1rem;
      padding: .3rem;
      margin-top: .25rem;
      background: var(--control-bg);
      color: var(--fg);
      border: 1px solid var(--control-border);
      border-radius: 3px;
    }
    button {
      padding: .4rem 1rem;
      font-size: 1rem;
      cursor: pointer;
      background: var(--control-bg);
      color: var(--fg);
      border: 1px solid var(--control-border);
      border-radius: 3px;
    }
    button.danger { background: var(--danger); color: var(--danger-fg); border-color: var(--danger); }
    .watched-list { list-style: none; padding: 0; }
    .watched-list li { padding: .4rem 0; border-bottom: 1px solid var(--border); }
    .error { color: var(--danger); }
    .page-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .page-head h1 { margin: 0; font-size: 1.6rem; }
    .page-head h2 { margin: .2rem 0 0; font-size: 1rem; font-weight: normal; color: var(--muted); }
    .theme-toggle { flex: none; font-size: .8rem; padding: .3rem .6rem; }
  `;

// Runs before first paint so a stored choice does not flash the default theme.
const THEME_INIT = `
    try {
      var t = localStorage.getItem("theme");
      if (t) document.documentElement.dataset.theme = t;
    } catch (e) {}
  `;

const THEME_TOGGLE_SCRIPT = `
    (function () {
      var order = ["auto", "light", "dark"];
      var labels = { auto: "Temă: automat", light: "Temă: luminos", dark: "Temă: întunecat" };
      var btn = document.getElementById("theme-toggle");
      if (!btn) return;

      function current() {
        try { return localStorage.getItem("theme") || "auto"; } catch (e) { return "auto"; }
      }
      function render() {
        btn.textContent = labels[current()];
      }
      btn.hidden = false;
      render();

      btn.addEventListener("click", function () {
        var next = order[(order.indexOf(current()) + 1) % order.length];
        try {
          if (next === "auto") localStorage.removeItem("theme");
          else localStorage.setItem("theme", next);
        } catch (e) {}
        if (next === "auto") delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = next;
        render();
      });
    })();
  `;

function page(title: string, body: string, extraHead = ""): string {
  return `<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
${extraHead}  <title>${title}</title>
  <style>${STYLES}</style>
  <script>${THEME_INIT}</script>
</head>
<body>
${body}
  <script>${THEME_TOGGLE_SCRIPT}</script>
</body>
</html>`;
}

// Hidden until the script enables it, so it never appears without a handler.
const THEME_TOGGLE_BUTTON =
  `<button type="button" id="theme-toggle" class="theme-toggle" hidden>Temă</button>`;

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
          <button type="submit" class="danger" style="margin-left:.5rem">Oprește</button>
        </form>
      </li>`).join("")}
  </ul>`;

  return page("Valcroft — Urmărire disponibilitate", `  <div class="page-head">
    <div>
      <h1>Valcroft</h1>
      <h2>Urmărire disponibilitate</h2>
    </div>
    ${THEME_TOGGLE_BUTTON}
  </div>
  ${watchedSection}
  <form method="POST" action="${path}" style="margin-top:1.5rem">
    <label>Adaugă o dată:
      <input type="date" name="date" value="${tomorrow()}" required>
    </label>
    <button type="submit" name="action" value="watch">Urmărește această dată</button>
  </form>`);
}

export function renderConfirmPage(message: string, path: string): string {
  return page(
    "Valcroft",
    `  <p>${message}</p>
  <p><small>Redirecționare automată în 2 secunde…</small></p>
  <p><a href="${path}">Înapoi</a></p>`,
    `  <meta http-equiv="refresh" content="2;url=${path}">\n`
  );
}

export function renderErrorPage(message: string, path: string): string {
  return page("Valcroft — Eroare", `  <div class="page-head">
    <h1>Eroare</h1>
    ${THEME_TOGGLE_BUTTON}
  </div>
  <p class="error">${message}</p>
  <p><a href="${path}">Înapoi</a></p>`);
}
