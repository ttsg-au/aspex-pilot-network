// Page layout and small HTML helpers (server-rendered, no build step).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl2br = (s) => esc(s).replace(/\n/g, '<br>');

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d.length === 10 ? d + 'T00:00:00' : d);
  if (isNaN(dt)) return esc(d);
  return dt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });
}
function fmtDateTime(d) {
  if (!d) return '';
  return new Date(d).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Sydney' });
}

const NAV = [
  ['/', 'Dashboard'], ['/pilots', 'Pilots'], ['/messages', 'Messages'], ['/jobs', 'Jobs'], ['/import', 'Add / import'], ['/backup', 'Backup'],
];

function layout({ title, body, active = '', flash = '' }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Aspex Pilot Network</title>
<link rel="stylesheet" href="/static/style.css">
</head><body>
<header class="top"><div class="wrap topin">
<a class="brand" href="/"><span class="dot"></span>Aspex <b>Pilot Network</b></a>
<nav>${NAV.map(([h, l]) => `<a href="${h}" class="${active === h ? 'on' : ''}">${l}</a>`).join('')}</nav>
<form method="post" action="/logout" class="logout"><button class="link">Log out</button></form>
</div></header>
<main class="wrap">
${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
${body}
</main>
<script src="/static/app.js"></script>
</body></html>`;
}

function bare({ title, body }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/static/style.css"></head>
<body class="bare"><main class="narrow">${body}</main></body></html>`;
}

const options = (list, selected, { blank } = {}) =>
  (blank !== undefined ? `<option value="">${esc(blank)}</option>` : '') +
  list.map(o => {
    const [v, l] = Array.isArray(o) ? o : typeof o === 'object' ? [o.id, o.label] : [o, o];
    return `<option value="${esc(v)}"${String(v) === String(selected ?? '') ? ' selected' : ''}>${esc(l)}</option>`;
  }).join('');

const badge = (text, kind = '') => `<span class="badge ${kind}">${esc(text)}</span>`;

function expiryBadge(status, expiresOn) {
  if (status === 'expired') return badge('Expired ' + fmtDate(expiresOn), 'bad');
  if (status === 'soon') return badge('Expires ' + fmtDate(expiresOn), 'warn');
  if (status === 'ok') return badge('Valid to ' + fmtDate(expiresOn), 'good');
  return '';
}

module.exports = { esc, nl2br, fmtDate, fmtDateTime, layout, bare, options, badge, expiryBadge };
