// Admin login: one account for now (you). Password is stored only as a scrypt hash
// in .env (ADMIN_PASSWORD_HASH), created with `npm run set-password`.
// Sessions are signed cookies, so no session store is needed.
const crypto = require('crypto');
const config = require('./config');

const COOKIE = 'aspex_sid';
const SESSION_HOURS = 24 * 14;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function checkPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const test = crypto.scryptSync(pw, salt, 64);
  const want = Buffer.from(hash, 'hex');
  return want.length === test.length && crypto.timingSafeEqual(want, test);
}

const sign = (v) => crypto.createHmac('sha256', config.sessionSecret).update(v).digest('base64url');

function makeSession(res, email) {
  const payload = Buffer.from(JSON.stringify({ u: email, exp: Date.now() + SESSION_HOURS * 3600e3 })).toString('base64url');
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true, sameSite: 'lax', secure: config.baseUrl.startsWith('https'),
    maxAge: SESSION_HOURS * 3600e3, path: '/',
  });
}

function readSession(req) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!payload || !sig) return null;
  const good = sign(payload);
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return s.exp > Date.now() ? s : null;
  } catch { return null; }
}

function requireAdmin(req, res, next) {
  const s = readSession(req);
  if (!s) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  req.admin = s.u;
  next();
}

// Slow down password guessing: max 10 attempts per IP per 15 minutes.
const attempts = new Map();
function loginAllowed(ip) {
  const t = Date.now(), a = (attempts.get(ip) || []).filter(x => t - x < 15 * 60e3);
  attempts.set(ip, a);
  return a.length < 10;
}
function noteFailedLogin(ip) { (attempts.get(ip) || attempts.set(ip, []).get(ip)).push(Date.now()); }

// Signed tokens for links in emails (job responses), so pilots don't need a login.
function linkToken(...parts) { return sign(parts.join('|')).slice(0, 22); }
function checkLinkToken(token, ...parts) {
  const good = linkToken(...parts);
  return typeof token === 'string' && token.length === good.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(good));
}

module.exports = {
  COOKIE, hashPassword, checkPassword, makeSession, readSession, requireAdmin,
  loginAllowed, noteFailedLogin, linkToken, checkLinkToken,
};
