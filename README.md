# Aspex Pilot Network

> **Records are stored in the hosting's MySQL database.** On GoDaddy app hosting the app's own
> disk is wiped whenever the app restarts or redeploys, so the MySQL settings (`MYSQL_HOST`,
> `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, or a single `DATABASE_URL`) **must** be set
> as secrets. The dashboard shows a red warning if they aren't. The app creates its own two
> tables (`app_records`, `app_files`) the first time it connects. Certificate files are stored
> in the database too. Use the **Backup** page to download a full copy now and then.

The private admin system for the Aspex Drone Services National Pilot Network.

- **Pilot records:** everything from the registration form, plus your own notes.
- **Credentials:** ARN, operator accreditation, RePL, drone registration, insurance, White Card, AROC, ReOC and others, each with a number, issue and expiry dates, a certificate upload and a "Verified by me" tick.
- **Pathway stages:** Registered → Contacted → Credentials checked → Inducted → Supervised work → Approved for solo work, plus On hold and Not proceeding.
- **Two checklists on each pilot:**
  - "Ready for client sites (Part A)"
  - "ReOC track": RePL verified, ops manual induction, competency check in the last 12 months, and flight hours.
- **Records:** inductions, competency checks, agreements, supervised jobs, incidents, notes and a flight hours log.
- **Messaging:** email one pilot, a ticked selection, a filtered group or everyone. Each pilot gets their own email from admin@aspex.com.au.
  - You can personalise with `{first_name}`, `{name}`, `{state}`, `{home_base}` and `{missing}`.
  - `{missing}` lists the Part A items that pilot hasn't got yet.
- **Job call-outs:** send a job to chosen pilots. Each email has **I'm interested** and **Not available** buttons.
  - Replies, with an optional note, show on the job page.
  - You get an email the moment someone replies.
  - Assign pilots, then mark the job Completed to add it to each assigned pilot's history.
- **Expiry tracking:** the dashboard lists anything expired or expiring within 60 days, with a one-click renewal reminder email.
- **CSV export** of any filtered pilot list.

It is a standalone Node.js app, with no connection to Learn to Tow or TTSG. Data is kept in `data/db.json`, with a daily backup copy in `data/backups/` (last 30 days). Certificate files are kept in `data/uploads/`. There's no database server to set up.

---

## 1. Put it on GoDaddy (cPanel → Setup Node.js App)

1. **Choose the address.** For example `pilots.aspex.com.au`.
   - In cPanel → **Domains**, add it as a subdomain.
   - Point its DNS at this hosting. aspex.com.au's DNS is with GoDaddy, so add an A record for `pilots` with the IP address shown in cPanel.
   - Let AutoSSL issue the certificate so the address works on `https://`.
2. **Upload the files.**
   - In cPanel → **File Manager**, create a folder outside `public_html`, e.g. `/home/<you>/aspex-pilots`.
   - Upload `aspex-pilot-network.zip` there and choose **Extract**.
3. **Create the app.** In cPanel → **Setup Node.js App** → **Create Application**:
   - Node.js version: 18 or newer (the newest offered is best)
   - Application mode: Production
   - Application root: `aspex-pilots`
   - Application URL: `pilots.aspex.com.au`
   - Application startup file: `app.js`
   - Click **Create**, then **Run NPM Install**.
4. **Settings.**
   - In File Manager, copy `.env.example` to `.env`. Turn on "Show hidden files" in File Manager settings to see it.
   - Edit `.env`:
     - `BASE_URL=https://pilots.aspex.com.au`
     - Add a line `NEW_ADMIN_PASSWORD=` followed by the password you want, at least 10 characters.
     - Add the Microsoft 365 details (section 2).
5. **Set your login and import the existing sign-ups.** Back in Setup Node.js App, under **Run JS script**:
   - Run **set-password**. This turns your password into a secure hash, creates the session and webhook secrets, and removes the plain password from `.env`.
   - Upload `seed-registrations.json` (sent separately – it holds the pilots' personal details, so it is not in GitHub) into the `scripts` folder, then run **import-seed**. This adds the four pilots who registered before the app existed: Trevor Jennings, Christopher Fittler, Dylan and Salman Haider. Delete the file from the server afterwards.
6. **Start it.** Click **Restart**, then open `https://pilots.aspex.com.au` and log in as admin@aspex.com.au.

To update the app later, upload the new files over the old ones without touching `data/` or `.env`, then click **Restart**.

**Back up `data/`.** Download it from File Manager every so often. It holds all pilot records and certificates.

## 2. Sending email from admin@aspex.com.au (Microsoft 365)

GoDaddy's app hosting blocks outgoing email ports, so plain SMTP (`smtp.office365.com:587`) fails with
"Couldn't connect to the mail server". Use **Microsoft Graph** instead: it sends from the same mailbox,
over normal HTTPS, and the emails appear in your Sent Items.

**One-off setup in Microsoft Entra (about 10 minutes, as a Microsoft 365 admin):**

1. Go to **entra.microsoft.com → Applications → App registrations → New registration**.
   Name it `Aspex Pilot Network`, leave "Single tenant" selected, no redirect URI. Click **Register**.
2. On the app's **Overview** page, copy the **Application (client) ID** and the **Directory (tenant) ID**.
3. **Certificates & secrets → Client secrets → New client secret.** Pick 24 months. Copy the **Value**
   straight away (it's only shown once). Put a reminder in your calendar to renew it before it expires.
4. **API permissions → Add a permission → Microsoft Graph → Application permissions → Mail.Send → Add.**
   Then click **Grant admin consent for …** and confirm. The status should show a green tick.
5. In GoDaddy, add three secrets to the app:
   - `MS_TENANT_ID` = Directory (tenant) ID
   - `MS_CLIENT_ID` = Application (client) ID
   - `MS_CLIENT_SECRET` = the secret Value
6. Update Preview → Publish to Live, then open `/settings/test-email` in the app. It signs in to Microsoft
   and sends you a test email.

By default the Mail.Send permission lets this app send as any mailbox in your Microsoft 365 organisation.
The app only ever sends as the address in `MAIL_FROM` (admin@aspex.com.au). If you have other staff
mailboxes, you can restrict the app to that one mailbox with an Exchange *application access policy*.

If a send fails, the message page shows the reason and a **Resend to the … that failed** button.

Until Graph (or SMTP) is set up, the app is in **test mode**: emails are saved to `data/outbox/` instead of
being sent, and a yellow banner says so.

Microsoft 365 allows about 30 emails a minute from one mailbox, so group emails are sent about one every
two seconds. The message page refreshes to show progress.

## 3. Feeding new registrations in from the website

**If the form on aspex.com.au/pilot-network is an Elementor Pro form:**

1. Edit the page in Elementor and click the form.
2. Open **Actions After Submit** and add **Webhook**. Keep the existing **Email** action so you still get the notification email.
3. In the new **Webhook** section, set the URL to `https://pilots.aspex.com.au/api/register?key=<WEBHOOK_SECRET from .env>`.
4. Turn on **Advanced Data**.
5. Update the page and submit a test registration. It should appear under Pilots.

The app recognises the form's existing field labels ("Full name", "Home base (town, state)", "CASA credentials held" and so on). If you rename a field, keep its wording close.

**If the form isn't Elementor**, or until the webhook is set up: copy the body of each "Expression of Interest – Pilot Network" email and paste it into **Add / import**. If someone registers twice, their existing record is updated instead of duplicated.

## 4. Day-to-day

- **A new registration arrives.**
  1. Open the pilot and set their **state** if it wasn't worked out from their home base.
  2. From the dashboard, click **Send these … their next steps**. Each pilot's email lists exactly what they're missing.
- **A certificate comes in.**
  1. On the pilot's record, open the credential's **Edit**.
  2. Add the number, dates and file, and tick **Verified by me**. The checklists update.
- **A job comes up.**
  1. Go to **Jobs → New job**. Pilots in that state and Part are pre-filtered.
  2. Tick the pilots to send it to, then press **Send job**.
  3. Watch the replies come in, then **Assign** a pilot.
- **Finding the right pilots.** Filter the Pilots list by state, Part, stage, credential, drone or travel range. Then tick pilots, or use "Message everyone in this list".

## Coming next (stage 2)

- **Pilot logins:** each pilot updates their own details and uploads their own certificates. Anything they change shows as "not verified" until you check it.
- **Automatic reminders:** a daily email to pilots whose credentials are about to expire, plus a weekly summary for you.
