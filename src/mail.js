// Sends email as admin@aspex.com.au through Microsoft 365.
//
// Two ways to send, chosen automatically:
//  1. Microsoft Graph API (preferred): works over HTTPS, so it isn't affected by hosts that
//     block email ports. Needs MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET (an app
//     registration in Microsoft Entra with the Mail.Send application permission).
//  2. SMTP (smtp.office365.com:587) with SMTP_USER / SMTP_PASS. Many app hosts, including
//     GoDaddy's app hosting, block this port, so the connection fails.
// With neither set up, emails are saved to data/outbox instead (test mode).
//
// Each pilot gets their own copy (no one sees anyone else's address).
// Microsoft 365 allows about 30 messages a minute per mailbox, so group sends are paced.
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const config = require('./config');

const OUTBOX = path.join(config.dataDir, 'outbox');
const method = () => (config.graph.configured ? 'graph' : config.smtp.pass ? 'smtp' : 'test');

// ---------- SMTP ----------
let transport = null;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
      requireTLS: config.smtp.port === 587,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
      connectionTimeout: 15000,
    });
  }
  return transport;
}

// ---------- Microsoft Graph ----------
let token = null; // { value, expires }
async function graphToken() {
  if (token && token.expires > Date.now() + 60e3) return token.value;
  const g = config.graph;
  const res = await fetch(`${g.loginBase}/${encodeURIComponent(g.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: g.clientId, client_secret: g.clientSecret,
      scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Microsoft sign-in failed: ${body.error_description || body.error || res.status}`);
  token = { value: body.access_token, expires: Date.now() + (body.expires_in || 3600) * 1000 };
  return token.value;
}
const addressOf = (s) => (String(s).match(/<([^>]+)>/) || [null, s])[1].trim();
async function graphSend(msg) {
  const from = addressOf(config.smtp.from);
  const res = await fetch(`${config.graph.apiBase}/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await graphToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: msg.subject,
        body: { contentType: 'HTML', content: msg.html },
        toRecipients: [{ emailAddress: { address: msg.to } }],
        replyTo: msg.replyTo ? [{ emailAddress: { address: addressOf(msg.replyTo) } }] : [],
      },
      saveToSentItems: true,
    }),
  });
  if (res.status === 202 || res.ok) return { graph: true };
  const body = await res.json().catch(() => ({}));
  const e = body.error || {};
  throw new Error(`Microsoft rejected the email (${res.status} ${e.code || ''}): ${e.message || 'no details'}`);
}

// ---------- Errors in plain words ----------
function describeError(err) {
  if (!err) return 'Unknown error';
  const inner = Array.isArray(err.errors) ? err.errors : [];
  const codes = [err.code, ...inner.map(x => x && x.code)].filter(Boolean);
  const detail = err.message || inner.map(x => x && x.message).filter(Boolean).join('; ') || err.name || String(err);
  if (codes.some(c => /ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ECONNRESET|ESOCKET|ECONNECTION|EACCES/.test(c)) || err.name === 'AggregateError') {
    const f = config.graph.found;
    const missing = [!f.tenantId && 'MS_TENANT_ID', !f.clientId && 'MS_CLIENT_ID', !f.clientSecret && 'MS_CLIENT_SECRET'].filter(Boolean);
    return `Couldn't connect to the mail server (${[...new Set(codes)].join(', ') || detail}). The host is blocking email port ${config.smtp.port}, so Microsoft Graph sending is needed. ` +
      (missing.length ? `The app can't see these Graph settings: ${missing.join(', ')}. Check their names and values in the host's Secrets, then publish again.` : 'See README.');
  }
  if (codes.includes('EAUTH') || /535|authentication/i.test(detail)) {
    return `Microsoft refused the login (${detail}). Check SMTP_PASS, and that Authenticated SMTP is enabled for the mailbox.`;
  }
  return detail;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Plain text → simple branded HTML. Blank lines become paragraphs; URLs become links; **text** becomes bold.
function toHtml(text, buttons = []) {
  const paras = String(text).split(/\n{2,}/).map(p =>
    `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`).join('');
  const btns = buttons.length ? `<p style="margin:22px 0">${buttons.map(b =>
    `<a href="${esc(b.url)}" style="display:inline-block;margin:0 8px 8px 0;padding:11px 20px;border-radius:6px;text-decoration:none;font-weight:600;background:${b.primary ? '#0f5e9c' : '#e8edf2'};color:${b.primary ? '#fff' : '#1d2b36'}">${esc(b.label)}</a>`).join('')}</p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#f3f5f7;font-family:Segoe UI,Arial,sans-serif;color:#1d2b36;font-size:15px;line-height:1.5">
<div style="max-width:620px;margin:0 auto;padding:24px 16px">
<div style="background:#fff;border-radius:8px;padding:26px 26px 12px;border:1px solid #e1e6eb">
${paras}${btns}
</div>
<p style="color:#6b7a86;font-size:12px;margin:14px 4px">Aspex Drone Services · National Pilot Network · aspex.com.au</p>
</div></body></html>`;
}

async function send({ to, subject, text, buttons = [] }) {
  const plain = text.replace(/\*\*(.+?)\*\*/g, '$1');
  const msg = {
    from: config.smtp.from, replyTo: config.smtp.replyTo, to, subject,
    text: plain + (buttons.length ? '\n\n' + buttons.map(b => `${b.label}: ${b.url}`).join('\n') : ''),
    html: toHtml(text, buttons),
  };
  const m = method();
  if (m === 'test') {
    fs.mkdirSync(OUTBOX, { recursive: true });
    const file = path.join(OUTBOX, `${Date.now()}-${String(to).replace(/[^a-z0-9@.]/gi, '_')}.json`);
    fs.writeFileSync(file, JSON.stringify(msg, null, 2));
    return { dryRun: true };
  }
  try {
    if (m === 'graph') return await graphSend(msg);
    const info = await getTransport().sendMail(msg);
    return { messageId: info.messageId };
  } catch (e) {
    const wrapped = new Error(describeError(e));
    wrapped.cause = e;
    throw wrapped;
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const paceMs = () => (method() === 'test' ? 0 : 2200); // ~27 a minute, under Microsoft's limit

// Sends a batch in the background; onEach(recipient, result|error) records progress.
// If the very first email can't even connect, the rest are marked failed straight away
// with the same reason instead of each waiting to time out.
async function sendBatch(items, onEach) {
  let fatal = null;
  for (const item of items) {
    if (fatal) { onEach(item, null, fatal); continue; }
    try { onEach(item, await send(item), null); }
    catch (e) {
      onEach(item, null, e);
      if (/Couldn't connect|refused the login|sign-in failed/.test(e.message)) fatal = e;
    }
    if (paceMs()) await sleep(paceMs());
  }
}

async function verify() {
  const m = method();
  if (m === 'test') return 'Test mode: emails are saved to data/outbox, not sent (no Microsoft Graph or SMTP settings).';
  if (m === 'graph') { await graphToken(); return `Signed in to Microsoft Graph; sending as ${addressOf(config.smtp.from)}.`; }
  try { await getTransport().verify(); } catch (e) { throw new Error(describeError(e)); }
  return `Connected to ${config.smtp.host} as ${config.smtp.user}.`;
}

module.exports = { send, sendBatch, verify, toHtml, method, describeError };
