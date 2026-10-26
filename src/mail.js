// Sends email as admin@aspex.com.au through Microsoft 365 (SMTP, smtp.office365.com:587).
// Each pilot gets their own copy (no one sees anyone else's address).
// Microsoft 365 allows about 30 messages a minute per mailbox, so group sends are paced.
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const config = require('./config');

const OUTBOX = path.join(config.dataDir, 'outbox');

let transport = null;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
      requireTLS: config.smtp.port === 587,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
  }
  return transport;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Plain text → simple branded HTML. Blank lines become paragraphs; URLs become links.
function toHtml(text, buttons = []) {
  const paras = String(text).split(/\n{2,}/).map(p =>
    `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`).join('');
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
  const msg = {
    from: config.smtp.from, replyTo: config.smtp.replyTo, to, subject,
    text: text + (buttons.length ? '\n\n' + buttons.map(b => `${b.label}: ${b.url}`).join('\n') : ''),
    html: toHtml(text, buttons),
  };
  if (config.mailDryRun) {
    fs.mkdirSync(OUTBOX, { recursive: true });
    const file = path.join(OUTBOX, `${Date.now()}-${String(to).replace(/[^a-z0-9@.]/gi, '_')}.json`);
    fs.writeFileSync(file, JSON.stringify(msg, null, 2));
    return { dryRun: true };
  }
  const info = await getTransport().sendMail(msg);
  return { messageId: info.messageId };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PACE_MS = config.mailDryRun ? 0 : 2200; // ~27 a minute, under Microsoft's limit

// Sends a batch in the background; onEach(recipient, result|error) records progress.
async function sendBatch(items, onEach) {
  for (const item of items) {
    try { onEach(item, await send(item), null); }
    catch (e) { onEach(item, null, e); }
    if (PACE_MS) await sleep(PACE_MS);
  }
}

async function verify() {
  if (config.mailDryRun) return 'Test mode: emails are saved to data/outbox, not sent (SMTP_PASS not set).';
  await getTransport().verify();
  return `Connected to ${config.smtp.host} as ${config.smtp.user}.`;
}

module.exports = { send, sendBatch, verify, toHtml };
