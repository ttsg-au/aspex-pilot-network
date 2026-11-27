// Aspex Uploader: the Windows app pilots use to back up SD cards to their SSD and upload to the Aspex Dropbox.
// The logbook hands it out and keeps it up to date:
//   - "Aspex Uploader Setup.cmd" (downloaded from the logbook) installs it with that person's upload key built in.
//   - Each time the app starts it asks for the current version and updates itself.
//   - It gets the person's job list from here, so nobody types a job name.
//   - It reports backup and upload progress here, so Aspex sees where each pilot is on the job page.
//
// The rclone connection file (Dropbox app folder only, never the SiteMark keys) comes from the
// UPLOADER_RCLONE_CONF_B64 setting (base64 of the pilots' rclone.conf), so it is never in GitHub.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const store = require('./store');
const coverage = require('./coverage');

const DIR = path.join(__dirname, 'uploader');
const APP = path.join(DIR, 'AspexUploader.ps1');
const LOGO = path.join(DIR, 'logo.png');
const STATE = 'pilotUploads';                       // state name, keyed 'job:<key>'

const appBytes = () => fs.readFileSync(APP);
// The version is the SHA-1 of the script file, so the app can work out its own version the same way.
const version = () => crypto.createHash('sha1').update(appBytes()).digest('hex').toUpperCase();
const fail = (res, e, code = 400) => res.status(code).type('text').send(String(e?.message || e));

function rcloneConf() {
  const b64 = (process.env.UPLOADER_RCLONE_CONF_B64 || '').trim();
  if (!b64) return null;
  try {
    const txt = Buffer.from(b64, 'base64').toString('utf8');
    return /\[\s*aspex\s*\]/.test(txt) ? txt : null;
  } catch { return null; }
}
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);

// Jobs this person can upload to: the owner's own jobs, or the Aspex jobs a pilot is assigned to.
function jobsFor(u) {
  if (u.role === 'owner') {
    const ops = store.ops(u.id);
    return Object.entries(ops.jobs || {})
      .filter(([, j]) => j && j.status !== 'Cancelled')
      .map(([key, j]) => ({ key, name: j.name || 'Untitled job', start: j.start || '', site: ops.sites?.[j.siteId]?.name || '' }));
  }
  return require('./network').jobsFor(u).map(j => ({ key: j.key, name: j.name || 'Aspex job', start: j.start || '', site: j.site?.name || '' }));
}

// ---------- for the app on the pilot's PC (upload key checked by routes.js) ----------
const pc = express.Router();
pc.get('/logbook/api/pc/uploader/version', (req, res) => res.json({ version: version() }));
pc.get('/logbook/api/pc/uploader/app', (req, res) => res.type('application/octet-stream').send(appBytes()));
pc.get('/logbook/api/pc/uploader/logo', (req, res) => fs.existsSync(LOGO) ? res.type('image/png').send(fs.readFileSync(LOGO)) : res.status(404).end());
pc.get('/logbook/api/pc/uploader/conf', (req, res) => {
  const c = rcloneConf();
  if (!c) return fail(res, 'The Aspex upload connection hasn’t been set up on the logbook yet. Ask Kimberly.', 404);
  res.type('text/plain').send(c);
});
pc.get('/logbook/api/pc/uploader/jobs', (req, res) => {
  const jobs = jobsFor(req.lb).sort((a, b) => (b.start || '').localeCompare(a.start || '') || a.name.localeCompare(b.name));
  res.json({ name: safeName(req.lb.name) || safeName(req.lb.email.split('@')[0]), jobs: jobs.map(j => ({ ...j, folder: safeName(j.name) })) });
});

const num = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
pc.post('/logbook/api/pc/uploader/report', express.json({ limit: '20kb' }), (req, res) => {
  const b = req.body || {};
  const key = store.safeKey(b.job);
  const job = key && jobsFor(req.lb).find(j => j.key === key);
  if (!job) return fail(res, 'That job isn’t one of yours.', 404);
  const task = b.task === 'backup' ? 'backup' : 'upload';
  const r = {
    status: ['running', 'waiting', 'done', 'stopped'].includes(b.status) ? b.status : 'running',
    phase: ['copy', 'check', 'size'].includes(b.phase) ? b.phase : '',
    pct: num(b.pct, 0, 100), doneBytes: num(b.doneBytes, 0, 1e15), totalBytes: num(b.totalBytes, 0, 1e15),
    speed: num(b.speed, 0, 1e12), etaSec: num(b.etaSec, 0, 1e8),
    files: num(b.files, 0, 1e8), bytes: num(b.bytes, 0, 1e15),
    elapsedSec: num(b.elapsedSec, 0, 1e8), reconnects: num(b.reconnects, 0, 1e6),
    checkOk: b.checkOk === true, note: store.clean(b.note, 200), source: store.clean(b.source, 200),
    started: store.clean(b.started, 40), at: new Date().toISOString(),
  };
  const all = store.state(STATE, 'job:' + key, {});
  const mine = all[req.lb.id] || {};
  all[req.lb.id] = { ...mine, name: req.lb.name || req.lb.email, [task]: r };
  store.setState(STATE, 'job:' + key, all);
  res.json({ ok: true });
});

// ---------- for the logbook pages (logged in) ----------
const router = express.Router();
router.get('/logbook/aspex-uploader-setup.cmd', (req, res) => {
  res.type('application/octet-stream').attachment('Aspex Uploader Setup.cmd').send(setupCmd(`${req.protocol}://${req.get('host')}`, req.lb.uploadKey));
});
// Upload progress on a job: the owner sees everyone's, a pilot sees their own.
router.get('/logbook/api/uploads/:key', (req, res) => {
  const key = store.safeKey(req.params.key);
  if (!key || !jobsFor(req.lb).some(j => j.key === key)) return fail(res, 'That job isn’t one of yours.', 404);
  const all = store.state(STATE, 'job:' + key, {});
  const rows = Object.entries(all).filter(([uid]) => req.lb.role === 'owner' || uid === String(req.lb.id))
    .map(([uid, v]) => ({ name: v.name, backup: v.backup || null, upload: v.upload || null }));
  res.json({ rows, setUp: !!rcloneConf() });
});

// The installer: a .cmd that runs the PowerShell after the #> line (nothing to install first).
function setupCmd(baseUrl, key) {
  const ps = String.raw`
$ErrorActionPreference = 'Stop'
$Site = '__SITE__'
$Key  = '__KEY__'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Host.UI.RawUI.WindowTitle = 'Aspex Uploader - setting up'
function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Finish($code) { Say ''; Read-Host 'Press Enter to close'; exit $code }
$h = @{ 'X-Logbook-Key' = $Key }
$dest = Join-Path $env:LOCALAPPDATA 'Aspex Uploader'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Say 'Setting up Aspex Uploader...' Cyan
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$Site/logbook/api/pc/uploader/app" -Headers $h -OutFile (Join-Path $dest 'AspexUploader.ps1')
  try { Invoke-WebRequest -UseBasicParsing -Uri "$Site/logbook/api/pc/uploader/logo" -Headers $h -OutFile (Join-Path $dest 'logo.png') } catch { }
  Invoke-WebRequest -UseBasicParsing -Uri "$Site/logbook/api/pc/uploader/conf" -Headers $h -OutFile (Join-Path $dest 'rclone.conf')
} catch {
  Say "Could not get Aspex Uploader from the logbook: $($_.Exception.Message)" Red
  Say 'Check the internet connection and run this again. If it keeps failing, tell Kimberly.' Yellow
  Finish 1
}
@{ Site = $Site; Key = $Key } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dest 'config.json') -Encoding UTF8
if (-not (Test-Path -LiteralPath (Join-Path $dest 'rclone.exe'))) {
  Say 'Downloading rclone (the upload engine, about 25 MB)...'
  $zip = Join-Path $env:TEMP 'rclone-aspex.zip'; $tmp = Join-Path $env:TEMP 'rclone-aspex'
  try {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://downloads.rclone.org/rclone-current-windows-amd64.zip' -OutFile $zip
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp
    $exe = Get-ChildItem -LiteralPath $tmp -Recurse -Filter 'rclone.exe' | Select-Object -First 1
    Copy-Item -LiteralPath $exe.FullName -Destination (Join-Path $dest 'rclone.exe') -Force
    Remove-Item -LiteralPath $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
  } catch {
    Say "Could not download rclone: $($_.Exception.Message)" Red
    Say 'Check the internet connection and run this again.' Yellow
    Finish 1
  }
}
Get-ChildItem -LiteralPath $dest -File | Unblock-File
$ps   = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$app  = Join-Path $dest 'AspexUploader.ps1'
$base = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $app + '"'
$sh = New-Object -ComObject WScript.Shell
foreach ($l in @(
    @{ Path = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Aspex Uploader.lnk'); Args = $base },
    @{ Path = (Join-Path ([Environment]::GetFolderPath('Programs')) 'Aspex Uploader.lnk'); Args = $base },
    @{ Path = (Join-Path ([Environment]::GetFolderPath('Startup')) 'Aspex Uploader (resume).lnk'); Args = "$base -Resume" })) {
  $s = $sh.CreateShortcut($l.Path); $s.TargetPath = $ps; $s.Arguments = $l.Args; $s.WorkingDirectory = $dest; $s.WindowStyle = 7; $s.Save()
}
Say ''
Say 'Aspex Uploader is ready. It is on your desktop, and it is opening now.' Green
Start-Process -FilePath $ps -ArgumentList $base -WorkingDirectory $dest
Start-Sleep 4
exit 0
`.replace('__SITE__', baseUrl.replace(/'/g, "''")).replace('__KEY__', key);

  return `<# :
@echo off
title Aspex Uploader - setting up
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = Get-Content -LiteralPath '%~f0' -Raw; Invoke-Expression ($s.Substring($s.IndexOf('#'+'>') + 2))"
exit /b
#>
${ps.trim()}
`.replace(/\r?\n/g, '\r\n');
}

module.exports = { pc, router, version, setupCmd, jobsFor };
