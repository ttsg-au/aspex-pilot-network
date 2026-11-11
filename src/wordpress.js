// Creates member logins on the Aspex WordPress site (aspex.com.au) for pilots, using the
// WordPress REST API with an application password. Access to the members-only pages is
// controlled by the WordPress role (Members plugin), so the app just creates the user with that role.
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

const DEFAULTS = {
  key: 'wordpress',
  role: 'subscriber',
  subject: 'Your Aspex Pilot Hub login',
  body: `Hi {first_name},

You now have a login for the members area of the Aspex website, which gives you access to the Pilot Hub and Training Hub.

Your username is your email address: {email}

To set your password:
1. Go to https://aspex.com.au/wp-login.php?action=lostpassword
2. Enter your email address and click "Get New Password".
3. Open the email from the Aspex website and follow the link to choose your password.

Once that's done, log in at https://aspex.com.au/wp-login.php

If you have any trouble, just reply to this email.

Kind regards,
Kimberly Olsen
Aspex Drone Services`,
};

function getSettings() {
  const s = db.where('settings', r => r.key === 'wordpress')[0];
  return { ...DEFAULTS, ...(s || {}) };
}
function saveSettings(changes) {
  const s = db.where('settings', r => r.key === 'wordpress')[0];
  if (s) db.update('settings', s.id, changes);
  else db.insert('settings', { ...DEFAULTS, ...changes });
}

async function api(path, { method = 'GET', body } = {}) {
  const wp = config.wordpress;
  if (!wp.configured) throw new Error('The WordPress login details aren’t set up yet (WP_USER and WP_APP_PASSWORD).');
  const auth = Buffer.from(wp.user + ':' + wp.appPassword.replace(/\s+/g, '')).toString('base64');
  let res;
  try {
    res = await fetch(wp.url + '/wp-json/wp/v2' + path, {
      method, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { throw new Error('Couldn’t reach ' + wp.url + ' (' + e.message + ').'); }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const err = new Error(describe(res.status, data, text));
    err.code = data && data.code; err.status = res.status;
    throw err;
  }
  if (!data) throw new Error('WordPress sent back something unexpected (not JSON). A security plugin or the host may be blocking the REST API.');
  return data;
}

function describe(status, data, text) {
  const code = data && data.code;
  if (status === 401 || code === 'rest_not_logged_in' || code === 'incorrect_password' || code === 'invalid_username')
    return 'WordPress didn’t accept the login. Check WP_USER is your WordPress username and WP_APP_PASSWORD is an application password (not your normal password).';
  if (status === 403 || code === 'rest_cannot_create_user') return 'WordPress accepted the login, but that user isn’t allowed to create users. Use an Administrator account.';
  if (code === 'rest_invalid_param' && /role/i.test(text)) return 'WordPress doesn’t recognise the role set in Website logins settings. Check the role’s exact name.';
  if (status === 404) return 'The WordPress REST API wasn’t found at this address. Check WP_URL.';
  return `WordPress said: ${(data && data.message) || ('error ' + status)}`;
}

// Who the app is logged in as, and whether it can create users.
async function test() {
  const me = await api('/users/me?context=edit');
  return { name: me.name, username: me.username, roles: me.roles || [], canCreate: !!(me.capabilities && me.capabilities.create_users) };
}

// Create (or find) the pilot's WordPress user and give them the pilot role.
// Returns { status: 'created' | 'existing' | 'updated', id }.
async function createLogin(p) {
  const { role } = getSettings();
  const parts = String(p.fullName || '').trim().split(/\s+/);
  try {
    const u = await api('/users', { method: 'POST', body: {
      username: p.email, email: p.email, name: p.fullName, nickname: parts[0] || p.email,
      first_name: parts[0] || '', last_name: parts.slice(1).join(' '),
      roles: [role], password: crypto.randomBytes(24).toString('base64url'),
    } });
    return { status: 'created', id: u.id };
  } catch (e) {
    if (e.code !== 'existing_user_email' && e.code !== 'existing_user_login') throw e;
    // They already have an account: make sure it has the pilot role (without removing any others).
    const found = await api('/users?context=edit&per_page=100&search=' + encodeURIComponent(p.email));
    const u = found.find(x => String(x.email || '').toLowerCase() === p.email.toLowerCase()) || found[0];
    if (!u) throw e;
    if ((u.roles || []).includes(role)) return { status: 'existing', id: u.id };
    await api('/users/' + u.id, { method: 'POST', body: { roles: [...new Set([...(u.roles || []), role])] } });
    return { status: 'updated', id: u.id };
  }
}

module.exports = { getSettings, saveSettings, test, createLogin, DEFAULTS };
