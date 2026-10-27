// Aspex Drone Services – Pilot Network
// Entry point. On GoDaddy cPanel "Setup Node.js App", set the startup file to app.js.
const express = require('express');
const path = require('path');
const config = require('./src/config');
const db = require('./src/db');
const auth = require('./src/auth');
const main = require('./src/routes/main');
const pilots = require('./src/routes/pilots');
const comms = require('./src/routes/comms');

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
// If the database couldn't be reached at start-up, say so plainly instead of running without it.
let dbError = null;
app.use((req, res, next) => dbError && req.path !== '/health'
  ? res.status(503).send('The pilot network app can\u2019t reach its database right now. Check the MySQL settings in the hosting secrets and the runtime logs, then restart the app.')
  : next());
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Health check for the host: always answers 200 without needing a login.
app.get('/health', (req, res) => res.status(dbError ? 503 : 200).type('text').send(dbError ? 'database error' : 'ok ' + db.mode()));

// Public: login, website form webhook, pilots' job replies.
app.use(main.publicRouter);
app.use(comms.publicRouter);

// Everything else needs you logged in.
app.use(auth.requireAdmin);
app.use(main.router);
app.use(pilots.router);
app.use(comms.router);

app.use((req, res) => res.status(404).send('Not found'));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong: ' + (err && err.message));
});

// Load the database first, then start taking requests.
db.init().then(() => {
  app.listen(config.port, () => {
    console.log(`Aspex Pilot Network running on port ${config.port} (${config.mailDryRun ? 'email TEST MODE' : 'email live'}, storage: ${db.mode()})`);
  });
}).catch((e) => {
  console.error('Could not connect to the database:', e.message);
  dbError = e;
  // Still start, so the problem shows in the browser instead of a dead site.
  app.listen(config.port, () => console.log('Started WITHOUT a database on port ' + config.port));
});
