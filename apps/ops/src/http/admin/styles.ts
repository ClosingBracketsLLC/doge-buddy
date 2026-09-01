/**
 * The admin's ONLY stylesheet and ONLY script, inlined by `layout()` (html.ts). No build step, no
 * CDN, no framework — a design system small enough to read in one sitting. Mobile-first for the
 * owner's Galaxy Z Fold 8: `< 640px` is the cover screen (bottom tab bar, single column),
 * `640–1023px` the inner screen (left rail, two columns), `>= 1024px` desktop (rail with labels,
 * three columns). Dark by default; light follows `prefers-color-scheme`.
 */
export const ADMIN_CSS = `
:root {
  color-scheme: dark light;
  --bg: #0c1114; --surface: #10171a; --surface-2: #172026; --line: #26333a;
  --ink: #f2ede2; --muted: #9aa7ad; --accent: #f6ce18; --accent-ink: #10171a;
  --ok: #3ddc84; --warn: #ffb327; --bad: #ff3641; --info: #00e1ff;
  --tabbar-h: 64px; --rail-w: 72px; --radius: 12px;
  --font: -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #fdf3e0; --surface: #fffcf5; --surface-2: #fff7e6; --line: #e6d9bd;
    --ink: #10171a; --muted: #5b6a70; --accent: #bb6402; --accent-ink: #fff;
    --ok: #1f8f52; --warn: #b36b00; --bad: #c8232c; --info: #145069;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.45 var(--font); }
a { color: var(--accent); }
h1, h2, h3 { line-height: 1.2; margin: 0 0 12px; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.2rem; margin-top: 24px; } h3 { font-size: 1rem; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
p { margin: 0 0 8px; }
img { max-width: 100%; height: auto; }

/* --- shell -------------------------------------------------------------- */
.topbar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 12px; padding: 8px 16px; padding-top: max(8px, env(safe-area-inset-top)); background: var(--surface); border-bottom: 1px solid var(--line); }
.topbar .brand { font-weight: 700; text-decoration: none; color: var(--ink); white-space: nowrap; }
.topbar .page-title { flex: 1; font-size: 1.1rem; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topbar form { margin: 0; }
main { padding: 16px; max-width: 1200px; margin: 0 auto; overflow-x: hidden; }
.tabs { display: flex; gap: 2px; background: var(--surface); border-top: 1px solid var(--line); }
.tab { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-height: 44px; padding: 6px 4px; font-size: .75rem; color: var(--muted); text-decoration: none; position: relative; }
.tab .ico { font-size: 1.25rem; line-height: 1; }
.tab[aria-current="page"] { color: var(--accent); }
.tab .badge { position: absolute; top: 4px; right: calc(50% - 22px); }
.badge { display: inline-block; min-width: 18px; padding: 0 5px; border-radius: 9px; background: var(--accent); color: var(--accent-ink); font-size: .7rem; font-weight: 700; line-height: 18px; text-align: center; }
.badge.bad { background: var(--bad); color: #fff; }
.tab.more summary { list-style: none; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 2px; }
.tab.more summary::-webkit-details-marker { display: none; }
.tab.more a { display: block; padding: 12px 16px; color: var(--ink); text-decoration: none; min-height: 44px; }
@media (max-width: 639px) {
  .tabs { position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; height: calc(var(--tabbar-h) + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom); }
  main { padding-bottom: calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 16px); }
  .tab.more[open] .menu { position: absolute; bottom: 100%; right: 0; min-width: 160px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius) var(--radius) 0 0; box-shadow: 0 -8px 24px rgba(0,0,0,.35); }
}
@media (min-width: 640px) {
  body { display: grid; grid-template-columns: var(--rail-w) 1fr; grid-template-rows: auto 1fr; grid-template-areas: "top top" "rail main"; min-height: 100vh; }
  .topbar { grid-area: top; }
  .tabs { grid-area: rail; flex-direction: column; justify-content: flex-start; border-top: 0; border-right: 1px solid var(--line); position: sticky; top: 0; height: 100vh; padding-top: 8px; }
  .tab { flex: 0 0 auto; }
  .tab.more summary { display: none; }
  .tab.more .menu a { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 6px 4px; font-size: .75rem; color: var(--muted); }
  main { grid-area: main; width: 100%; }
}
@media (min-width: 1024px) {
  :root { --rail-w: 200px; }
  .tab, .tab.more .menu a { flex-direction: row; justify-content: flex-start; gap: 10px; padding: 10px 16px; font-size: .95rem; }
  .tab .badge { position: static; margin-left: auto; }
}

/* --- cards & grid ----------------------------------------------------- */
.grid { display: grid; gap: 12px; grid-template-columns: 1fr; }
@media (min-width: 640px) { .grid { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 1024px) { .grid { grid-template-columns: repeat(3, 1fr); } }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; }
a.card { display: block; color: inherit; text-decoration: none; }
.card .label { color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
.stat { font-size: clamp(1.75rem, 6vw, 2.5rem); font-weight: 700; line-height: 1.1; }
.stat.bad { color: var(--bad); } .stat.ok { color: var(--ok); } .stat.warn { color: var(--warn); }
.bar { height: 8px; border-radius: 4px; background: var(--surface-2); overflow: hidden; margin: 8px 0; }
.bar > i { display: block; height: 100%; background: var(--ok); }
.bar.warn > i { background: var(--warn); } .bar.bad > i { background: var(--bad); }
.kv { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid var(--line); }
.kv:first-of-type { border-top: 0; }
.kv .v { text-align: right; }
details.card > summary { cursor: pointer; font-weight: 600; }

/* --- chips ------------------------------------------------------------ */
.chip { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: .75rem; font-weight: 600; border: 1px solid currentColor; white-space: nowrap; }
.chip-ok { color: var(--ok); } .chip-warn { color: var(--warn); } .chip-bad { color: var(--bad); } .chip-info { color: var(--info); } .chip-muted { color: var(--muted); }
.chips { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; margin-bottom: 12px; }
.chips a { flex: 0 0 auto; padding: 8px 12px; border-radius: 999px; border: 1px solid var(--line); color: var(--ink); text-decoration: none; min-height: 40px; display: inline-flex; align-items: center; }
.chips a[aria-current="page"] { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }

/* --- tables ----------------------------------------------------------- */
.table-wrap { overflow-x: auto; }
table.rows { width: 100%; border-collapse: collapse; }
table.rows th, table.rows td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
table.rows th { color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
.mono { font-family: var(--mono); font-size: .85rem; }
td.mono { max-width: 12ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
td.wrap { white-space: normal; overflow-wrap: anywhere; }
@media (max-width: 639px) {
  table.rows thead { display: none; }
  table.rows, table.rows tbody, table.rows tr, table.rows td { display: block; width: 100%; }
  table.rows tr { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 6px 12px; margin-bottom: 10px; }
  table.rows td { display: flex; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--line); }
  table.rows td:last-child { border-bottom: 0; }
  table.rows td::before { content: attr(data-label); flex: 0 0 38%; color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  table.rows td:not([data-label])::before { display: none; }
  td.mono { max-width: none; white-space: normal; overflow-wrap: anywhere; }
}

/* --- forms & buttons -------------------------------------------------- */
form { margin: 0 0 12px; }
label { display: block; margin-bottom: 6px; color: var(--muted); font-size: .9rem; }
input:not([type=checkbox]):not([type=hidden]), select, textarea { width: 100%; font: inherit; font-size: 16px; color: var(--ink); background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; min-height: 44px; }
textarea { min-height: 8rem; font-family: var(--mono); font-size: .9rem; }
input[type=checkbox] { width: 24px; height: 24px; accent-color: var(--accent); }
button, .btn { font: inherit; font-weight: 600; min-height: 44px; padding: 10px 18px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface-2); color: var(--ink); cursor: pointer; }
button.primary, .btn.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
button.danger, .btn.danger { background: transparent; color: var(--bad); border-color: var(--bad); }
button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.seg { display: inline-flex; gap: 0; }
.seg button { border-radius: 0; }
.seg button:first-child { border-radius: 10px 0 0 10px; } .seg button:last-child { border-radius: 0 10px 10px 0; }
.toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.toggle label { margin: 0; color: var(--ink); font-size: 1rem; }
html.js .js-hide { display: none; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.actions form { margin: 0; }
.actions.sticky { position: sticky; bottom: 0; z-index: 10; background: var(--surface); border-top: 1px solid var(--line); margin: 16px -16px 0; padding: 12px 16px; }
@media (max-width: 639px) { .actions.sticky { bottom: calc(var(--tabbar-h) + env(safe-area-inset-bottom)); } }

/* --- misc ------------------------------------------------------------- */
pre { background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-x: auto; max-height: 50vh; font-family: var(--mono); font-size: .85rem; }
section { margin-bottom: 20px; }
.message { border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; margin-bottom: 10px; background: var(--surface); }
.message-outbound { border-color: var(--accent); }
.listing-images { display: flex; gap: 8px; overflow-x: auto; }
.listing-images img { height: 120px; width: auto; border-radius: 8px; }
.login { max-width: 420px; margin: 10vh auto; }
.empty { color: var(--muted); }
`

/**
 * Progressive enhancement only — without it every form still posts. (1) marks <html> as js-capable
 * so "Save" buttons on auto-submitting toggles can hide; (2) `data-confirm` forms ask before an
 * irreversible POST via the submit listener (ordinary button submits); (3) `data-autosubmit` forms
 * confirm right here in the change handler and post via \`.submit()\` — never \`.requestSubmit()\`,
 * because \`.submit()\` fires no \`submit\` event, so a form carrying BOTH \`data-autosubmit\` and
 * \`data-confirm\` (the kill-switch toggle) gets exactly one prompt, not a double prompt or an
 * unconfirmed post on engines lacking \`requestSubmit\`.
 */
export const ADMIN_JS = `
document.documentElement.classList.add('js');
document.addEventListener('submit', function (e) {
  var f = e.target; if (f && f.dataset && f.dataset.confirm && !window.confirm(f.dataset.confirm)) e.preventDefault();
});
document.addEventListener('change', function (e) {
  var el = e.target, f = el && el.form;
  if (!f || !f.dataset || !('autosubmit' in f.dataset)) return;
  if (f.dataset.confirm && !window.confirm(f.dataset.confirm)) {
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = !el.checked;
    else if (el.options) { for (var i = 0; i < el.options.length; i++) el.options[i].selected = el.options[i].defaultSelected; }
    else el.value = el.defaultValue;
    return;
  }
  f.submit();
});
`
