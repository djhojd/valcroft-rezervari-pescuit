import type { WatchedDate } from "./state";
import { formatDateLong } from "./notify";

function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Applied both from the system preference and from an explicit dark choice.
const DARK_TOKENS = `
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
      --accent: #3fa37c;
      --accent-hover: #4fb98f;
      --accent-fg: #10231c;
    `;

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
      --accent: #1a7f5a;
      --accent-hover: #15684a;
      --accent-fg: #fff;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {${DARK_TOKENS}}
    }
    :root[data-theme="dark"] {${DARK_TOKENS}}
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      font-size: 1.05rem;
      line-height: 1.6;
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
      background: var(--control-bg);
      color: var(--fg);
      border: 1px solid var(--control-border);
      border-radius: 3px;
    }
    .add-form { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-top: 1.5rem; }
    .add-form label { display: contents; }
    .add-form .field-label { flex: none; }
    button {
      padding: .4rem 1rem;
      font-size: 1rem;
      cursor: pointer;
      background: var(--control-bg);
      color: var(--fg);
      border: 1px solid var(--control-border);
      border-radius: 3px;
    }
    button:hover { border-color: var(--fg); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button.primary {
      background: var(--accent);
      color: var(--accent-fg);
      border-color: var(--accent);
      font-weight: 600;
    }
    button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
    button.danger { background: var(--danger); color: var(--danger-fg); border-color: var(--danger); }
    button.danger:hover { filter: brightness(1.1); border-color: var(--danger); }
    .watched-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
    .watched-list li {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: .5rem;
      padding: .7rem .9rem;
      background: var(--control-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    .error { color: var(--danger); }
    .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
    .page-head h1 { margin: 0; font-size: 1.6rem; }
    .theme-toggle {
      flex: none;
      width: 40px;
      height: 40px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .theme-toggle svg { width: 20px; height: 20px; display: block; }
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
      var icons = Array.prototype.slice.call(btn.querySelectorAll("[data-icon]"));

      function current() {
        try { return localStorage.getItem("theme") || "auto"; } catch (e) { return "auto"; }
      }
      function render() {
        var mode = current();
        icons.forEach(function (el) { el.hidden = el.dataset.icon !== mode; });
        btn.title = labels[mode];
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
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>%F0%9F%8E%A3</text></svg>">
  <meta name="theme-color" content="#fff" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#161616" media="(prefers-color-scheme: dark)">
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

const SVG_OPEN =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`;

// Each icon shows the mode currently in effect, not the one the next click selects.
const ICONS = {
  auto: `${SVG_OPEN}<rect x="2" y="3" width="20" height="14" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>`,
  light: `${SVG_OPEN}<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>`,
  dark: `${SVG_OPEN}<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path></svg>`,
};

// Hidden until the script enables it, so it never appears without a handler.
const THEME_TOGGLE_BUTTON = `<button type="button" id="theme-toggle" class="theme-toggle" hidden>
      <span data-icon="auto">${ICONS.auto}</span>
      <span data-icon="light" hidden>${ICONS.light}</span>
      <span data-icon="dark" hidden>${ICONS.dark}</span>
    </button>`;

export function renderWatchPage(list: WatchedDate[], path: string): string {
  const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));

  const watchedSection = sorted.length === 0
    ? `<p>Nicio dată urmărită momentan.</p>`
    : `<p>Date urmărite (verificare la fiecare 15 minute, până la 07:00 în acea zi):</p>
  <ul class="watched-list">
    ${sorted.map((w) => `
      <li>
        <strong>${formatDateLong(w.date)}</strong>
        <form method="POST" action="${path}">
          <input type="hidden" name="action" value="stop">
          <input type="hidden" name="date" value="${w.date}">
          <button type="submit" class="danger">Oprește</button>
        </form>
      </li>`).join("")}
  </ul>`;

  return page("Valcroft — Rezervări pescuit", `  <div class="page-head">
    <h1>Valcroft</h1>
    ${THEME_TOGGLE_BUTTON}
  </div>
  ${watchedSection}
  <form method="POST" action="${path}" class="add-form">
    <label>
      <span class="field-label">Adaugă o dată:</span>
      <input type="date" name="date" value="${tomorrow()}" required>
    </label>
    <button type="submit" name="action" value="watch" class="primary">Începe urmărire</button>
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
