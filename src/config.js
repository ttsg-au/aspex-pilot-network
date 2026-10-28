// Loads settings from a .env file next to app.js (no extra packages needed).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = process.env;
function hashOnce(pw) {
  const crypto = require('crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
module.exports = {
  ROOT,
  port: Number(env.PORT || 3000),
  // Public address of this app, used in email links (e.g. https://pilots.aspex.com.au)
  baseUrl: (env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  dataDir: env.DATA_DIR || path.join(ROOT, 'data'),
  uploadDir: env.UPLOAD_DIR || path.join(ROOT, 'data', 'uploads'),
  sessionSecret: env.SESSION_SECRET || 'change-me-' + ROOT,
  adminEmail: env.ADMIN_EMAIL || 'admin@aspex.com.au',
  // Either a hash made by `npm run set-password`, or a plain ADMIN_PASSWORD set as a
  // secret in the hosting control panel (hashed here at start-up, never stored).
  adminPasswordHash: env.ADMIN_PASSWORD_HASH || (env.ADMIN_PASSWORD ? hashOnce(env.ADMIN_PASSWORD) : ''),
  webhookSecret: env.WEBHOOK_SECRET || '',
  // Managed MySQL database (GoDaddy). Either one connection URL, or separate settings.
  // Several common names are accepted so the values can be copied straight from the host.
  mysql: (() => {
    const pick = (...names) => names.map(n => env[n]).find(v => v !== undefined && v !== '') || '';
    const url = pick('DATABASE_URL', 'MYSQL_URL', 'DB_URL');
    const host = pick('MYSQL_HOST', 'DB_HOST', 'DATABASE_HOST');
    return {
      url,
      host,
      port: Number(pick('MYSQL_PORT', 'DB_PORT', 'DATABASE_PORT') || 3306),
      user: pick('MYSQL_USER', 'DB_USER', 'DB_USERNAME', 'DATABASE_USER', 'DATABASE_USERNAME'),
      password: pick('MYSQL_PASSWORD', 'DB_PASSWORD', 'DB_PASS', 'DATABASE_PASSWORD'),
      database: pick('MYSQL_DATABASE', 'DB_NAME', 'DB_DATABASE', 'DATABASE_NAME'),
      ssl: pick('MYSQL_SSL', 'DB_SSL') === 'true',
      configured: !!(url || host),
    };
  })(),
  smtp: {
    host: env.SMTP_HOST || 'smtp.office365.com',
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'Aspex Drone Services <admin@aspex.com.au>',
    replyTo: env.MAIL_REPLY_TO || 'admin@aspex.com.au',
  },
  // When true, emails are written to data/outbox instead of being sent (for testing).
  // Microsoft Graph sending (preferred: works over HTTPS where email ports are blocked).
  graph: (() => {
    // Accept the names however they were typed in the host's Secrets page: any capitals,
    // spaces, dashes or underscores ("Tenant ID", "ms-tenant-id", "AZURE_TENANT_ID"...).
    const norm = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
    const byNorm = {};
    for (const [k, v] of Object.entries(env)) if (v) byNorm[norm(k)] = String(v).trim();
    const pick = (...names) => names.map(n => byNorm[norm(n)]).find(v => v) || '';
    const tenantId = pick('MS_TENANT_ID', 'GRAPH_TENANT_ID', 'AZURE_TENANT_ID', 'TENANT_ID', 'DIRECTORY_TENANT_ID', 'DIRECTORY_ID');
    const clientId = pick('MS_CLIENT_ID', 'GRAPH_CLIENT_ID', 'AZURE_CLIENT_ID', 'CLIENT_ID', 'APPLICATION_CLIENT_ID', 'APPLICATION_ID', 'APP_ID');
    const clientSecret = pick('MS_CLIENT_SECRET', 'GRAPH_CLIENT_SECRET', 'AZURE_CLIENT_SECRET', 'CLIENT_SECRET', 'CLIENT_SECRET_VALUE', 'SECRET_VALUE', 'MS_SECRET');
    return {
      tenantId, clientId, clientSecret,
      sendTenant: pick('MS_SEND_TENANT', 'MAILBOX_TENANT'),
      configured: !!(clientId && clientSecret),
      found: { tenantId: !!tenantId, clientId: !!clientId, clientSecret: !!clientSecret },
      loginBase: env.GRAPH_LOGIN_BASE || 'https://login.microsoftonline.com',
      apiBase: env.GRAPH_API_BASE || 'https://graph.microsoft.com',
    };
  })(),
  get mailDryRun() { return !this.graph.configured && !this.smtp.pass; },
  expiryWarnDays: Number(env.EXPIRY_WARN_DAYS || 60),
};
