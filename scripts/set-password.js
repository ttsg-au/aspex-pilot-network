// Sets (or changes) the admin password, and creates the other secrets in .env if missing.
// Usage: npm run set-password            (asks for the password)
//        npm run set-password -- "pass"  (non-interactive)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const envFile = path.join(__dirname, '..', '.env');
const { hashPassword } = require('../src/auth');

function upsert(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, line) : text.replace(/\n?$/, '\n') + line + '\n';
}
const hasValue = (text, key) => new RegExp(`^${key}=.+$`, 'm').test(text);

function finish(pw) {
  if (!pw || pw.length < 10) { console.error('Use at least 10 characters.'); process.exit(1); }
  let text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : fs.readFileSync(envFile + '.example', 'utf8');
  text = upsert(text, 'ADMIN_PASSWORD_HASH', hashPassword(pw));
  if (!hasValue(text, 'SESSION_SECRET')) text = upsert(text, 'SESSION_SECRET', crypto.randomBytes(32).toString('hex'));
  if (!hasValue(text, 'WEBHOOK_SECRET')) text = upsert(text, 'WEBHOOK_SECRET', crypto.randomBytes(18).toString('base64url'));
  fs.writeFileSync(envFile, text);
  console.log('Password saved to .env. Restart the app for it to take effect.');
}

// cPanel's "Run JS script" button can't pass arguments, so a NEW_ADMIN_PASSWORD
// line in .env also works; it is removed once the password has been saved.
const envText = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
const fromEnv = (envText.match(/^NEW_ADMIN_PASSWORD=(.*)$/m) || [])[1];
if (process.argv[2]) finish(process.argv[2]);
else if (fromEnv) {
  finish(fromEnv.trim());
  fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf8').replace(/^NEW_ADMIN_PASSWORD=.*\n?/m, ''));
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('New admin password: ', (pw) => { rl.close(); finish(pw.trim()); });
}
