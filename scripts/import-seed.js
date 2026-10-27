// Imports the pilots who registered before this app existed (from their
// notification emails). Safe to run twice: pilots are matched by email.
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const intake = require('../src/intake');

(async () => {
await db.init();
const seeds = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-registrations.json'), 'utf8'));
for (const s of seeds) {
  const reg = intake.parseNotificationEmail(s.text);
  const { pilot, isNew } = intake.upsertFromRegistration(reg, 'website form (imported from email)');
  if (isNew) db.update('pilots', pilot.id, { registeredAt: new Date(s.receivedAt).toISOString(), ...(s.state && !pilot.state ? { state: s.state } : {}) });
  console.log(`${isNew ? 'Added  ' : 'Updated'} ${pilot.fullName} <${pilot.email}> – state: ${pilot.state || '(unknown – set by hand)'}`);
}
await db.flush();
process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
