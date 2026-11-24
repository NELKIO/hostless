/**
 * Shared Shadow DOM styles. Theme from outside with custom properties on the element or any
 * ancestor: --hl-accent, --hl-bg, --hl-fg, --hl-muted, --hl-border, --hl-radius, --hl-font
 * (plus --hl-ok, --hl-warn, --hl-bad for the route/status colors).
 */
export const BASE_CSS = `
:host {
  --_accent: var(--hl-accent, #2563eb);
  --_accent-fg: var(--hl-accent-fg, #ffffff);
  --_bg: var(--hl-bg, #ffffff);
  --_fg: var(--hl-fg, #1a1d23);
  --_muted: var(--hl-muted, #5f6672);
  --_border: var(--hl-border, #d5d9e0);
  --_radius: var(--hl-radius, 10px);
  --_font: var(--hl-font, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  --_ok: var(--hl-ok, #15803d);
  --_warn: var(--hl-warn, #b45309);
  --_bad: var(--hl-bad, #b91c1c);
  --_none: var(--hl-none, #8a919c);
  --_soft: var(--hl-soft, rgba(128, 134, 145, 0.12));
  display: block;
  box-sizing: border-box;
  max-width: 100%;
  min-width: 0;
  color: var(--_fg);
  font: 15px/1.4 var(--_font);
}
@media (prefers-color-scheme: dark) {
  :host {
    --_accent: var(--hl-accent, #6ea0ff);
    --_accent-fg: var(--hl-accent-fg, #0b1020);
    --_bg: var(--hl-bg, #16181d);
    --_fg: var(--hl-fg, #e8eaee);
    --_muted: var(--hl-muted, #a0a7b4);
    --_border: var(--hl-border, #343944);
    --_ok: var(--hl-ok, #4ade80);
    --_warn: var(--hl-warn, #fbbf24);
    --_bad: var(--hl-bad, #f87171);
    --_none: var(--hl-none, #7c838f);
  }
}
:host([hidden]) { display: none; }
*, *::before, *::after { box-sizing: inherit; }
.card {
  background: var(--_bg);
  border: 1px solid var(--_border);
  border-radius: var(--_radius);
  padding: 12px;
  display: grid;
  gap: 10px;
  min-width: 0;
}
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-width: 0; }
.stack { display: grid; gap: 6px; min-width: 0; }
.muted { color: var(--_muted); font-size: 0.9em; }
.error { color: var(--_bad); font-size: 0.9em; margin: 0; }
.error:empty { display: none; }
p { margin: 0; }
h2, h3 { margin: 0; font-size: 1em; font-weight: 600; }
button {
  font: inherit;
  min-height: 40px;
  padding: 0 14px;
  border-radius: calc(var(--_radius) * 0.8);
  border: 1px solid var(--_border);
  background: var(--_bg);
  color: var(--_fg);
  cursor: pointer;
  max-width: 100%;
}
button:hover:not(:disabled) { border-color: var(--_accent); }
button.primary { background: var(--_accent); border-color: var(--_accent); color: var(--_accent-fg); font-weight: 600; }
button.danger { color: var(--_bad); border-color: currentColor; }
button[aria-pressed="true"] { background: var(--_soft); border-color: var(--_accent); font-weight: 600; }
button:disabled { opacity: 0.55; cursor: default; }
input {
  font: inherit;
  min-height: 40px;
  padding: 0 10px;
  border-radius: calc(var(--_radius) * 0.8);
  border: 1px solid var(--_border);
  background: var(--_bg);
  color: var(--_fg);
  width: 100%;
  min-width: 0;
}
input[aria-invalid="true"] { border-color: var(--_bad); }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--_accent); outline-offset: 2px; }
.code {
  font: 600 1.35em/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: 0.06em;
  overflow-wrap: anywhere;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.segmented { display: flex; gap: 6px; }
.segmented > button { flex: 1 1 0; }
.grow { flex: 1 1 160px; min-width: 0; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.peer {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px;
  padding: 6px 8px; border-radius: calc(var(--_radius) * 0.7); background: var(--_soft); min-width: 0;
}
.peer .name { font-weight: 600; flex: 1 1 120px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 1px 8px; border-radius: 999px; font-size: 0.82em; line-height: 1.6;
  border: 1px solid currentColor; white-space: nowrap;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
.route-direct, .status-online, .is-ok { color: var(--_ok); }
.route-relay, .status-connecting, .is-warn { color: var(--_warn); }
.route-none, .status-closed { color: var(--_none); }
.status-offline, .is-bad { color: var(--_bad); }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
`;

export const LINK_CSS = `
:host { display: inline-block; font-size: 13px; }
.pill {
  display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 8px;
  padding: 3px 10px; border: 1px solid var(--_border); border-radius: 999px;
  background: var(--_bg); max-width: 100%;
}
.state { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
.peers { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.badge { font-size: 0.92em; }
`;

export const TABLE_CSS = `
.scroll { overflow-x: auto; max-width: 100%; }
table { border-collapse: collapse; width: 100%; font-size: 0.86em; }
th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--_border); vertical-align: top; }
th { color: var(--_muted); font-weight: 600; }
td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
td.url { overflow-wrap: anywhere; min-width: 9em; }
td.err { overflow-wrap: anywhere; color: var(--_muted); }
dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 0; font-size: 0.92em; }
dt { color: var(--_muted); }
dd { margin: 0; }
.verdict { font-weight: 600; }
`;
