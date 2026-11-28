# Aspex Uploader - pilot backup and upload app (Windows)
# Backs up an SD card to an SSD, and uploads an SSD job folder or SD card to the Aspex Dropbox.
# Installed and kept up to date by the Aspex logbook ("Aspex Uploader Setup.cmd" from the logbook's Import window).
# Uses rclone.exe, rclone.conf and config.json (logbook address + upload key) from its own folder.
# Resumes by itself after dropouts and restarts, and reports progress to the logbook job page.

param([switch]$Resume)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------- Paths ----------
$AppDir   = $PSScriptRoot
$Rclone   = Join-Path $AppDir 'rclone.exe'
$Conf     = Join-Path $AppDir 'rclone.conf'
$ConfigFile = Join-Path $AppDir 'config.json'
$DataDir  = Join-Path $AppDir 'data'
$LogDir   = Join-Path $DataDir 'logs'
$StateFile    = Join-Path $DataDir 'state.json'
$SettingsFile = Join-Path $DataDir 'settings.json'
foreach ($d in @($DataDir, $LogDir)) { if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d | Out-Null } }

# ---------- One copy at a time ----------
$created = $false
$script:Mutex = New-Object System.Threading.Mutex($true, 'Local\AspexUploader', [ref]$created)
if (-not $created) {
    if (-not $Resume) { [System.Windows.Forms.MessageBox]::Show('Aspex Uploader is already open.', 'Aspex Uploader') | Out-Null }
    exit
}

# ---------- Keep the laptop awake while working ----------
Add-Type -Namespace Aspex -Name Power -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
function Set-Awake([bool]$on) {
    if ($on) { [void][Aspex.Power]::SetThreadExecutionState([uint32]2147483649) }   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    else     { [void][Aspex.Power]::SetThreadExecutionState([uint32]2147483648) }   # ES_CONTINUOUS
}

# ---------- Saved state and settings ----------
function Read-JsonFile($path) {
    if (-not (Test-Path -LiteralPath $path)) { return @{} }
    try {
        $o = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        $h = @{}
        foreach ($p in $o.psobject.Properties) { $h[$p.Name] = $p.Value }
        return $h
    } catch { return @{} }
}
function Write-JsonFile($path, $hash) { ($hash | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $path -Encoding UTF8 }

$script:State    = Read-JsonFile $StateFile
$script:Settings = Read-JsonFile $SettingsFile
function Save-State { Write-JsonFile $StateFile $script:State }

# Started at Windows sign-in: only carry on if a job was interrupted.
if ($Resume -and ($script:State['Status'] -ne 'running')) { exit }

# ---------- Logbook connection (written by the installer) ----------
$script:Site = ''; $script:Key = ''
if (Test-Path -LiteralPath $ConfigFile) {
    try { $c = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json; $script:Site = [string]$c.Site; $script:Key = [string]$c.Key } catch { }
}
if (-not $script:Site -or -not $script:Key -or -not (Test-Path -LiteralPath $Rclone) -or -not (Test-Path -LiteralPath $Conf)) {
    [System.Windows.Forms.MessageBox]::Show("Aspex Uploader isn't fully installed.`n`nIn your Aspex logbook, open Import, download 'Aspex Uploader Setup' and run it.", 'Aspex Uploader') | Out-Null
    exit
}
$KeyHeader = @{ 'X-Logbook-Key' = $script:Key }
function Invoke-Logbook([string]$path, [int]$timeout = 10) {
    return Invoke-RestMethod -UseBasicParsing -Uri ($script:Site + $path) -Headers $KeyHeader -TimeoutSec $timeout
}

# ---------- Update itself from the logbook ----------
try {
    $v = (Invoke-Logbook '/logbook/api/pc/uploader/version' 8).version
    $mine = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA1).Hash
    if ($v -and $v -ne $mine) {
        $tmp = Join-Path $DataDir 'update.ps1'
        Invoke-WebRequest -UseBasicParsing -Uri ($script:Site + '/logbook/api/pc/uploader/app') -Headers $KeyHeader -OutFile $tmp -TimeoutSec 60
        if ((Get-FileHash -LiteralPath $tmp -Algorithm SHA1).Hash -eq $v) {
            Copy-Item -LiteralPath $tmp -Destination $PSCommandPath -Force
            Remove-Item -LiteralPath $tmp -Force
            $script:Mutex.ReleaseMutex(); $script:Mutex.Dispose()
            $a = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '"'
            if ($Resume) { $a += ' -Resume' }
            Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $a -WorkingDirectory $AppDir
            exit
        }
    }
} catch { }   # offline: carry on with this version

# ---------- Helpers ----------
function Quote-Arg([string]$a) {
    if ($a -eq '') { return '""' }
    if ($a -notmatch '[\s"]') { return $a }
    $bs = [char]92
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $n = 0
    foreach ($ch in $a.ToCharArray()) {
        if ($ch -eq $bs) { $n++ }
        elseif ($ch -eq '"') { [void]$sb.Append($bs, 2 * $n + 1); [void]$sb.Append('"'); $n = 0 }
        else { if ($n -gt 0) { [void]$sb.Append($bs, $n) }; $n = 0; [void]$sb.Append($ch) }
    }
    if ($n -gt 0) { [void]$sb.Append($bs, 2 * $n) }
    [void]$sb.Append('"')
    return $sb.ToString()
}
function Clean-Name([string]$s) { return ($s -replace '[\\/:*?"<>|]', '').Trim() }
function Format-Size([double]$bytes) {
    if ($bytes -ge 1GB) { return ('{0:N1} GiB' -f ($bytes / 1GB)) }
    return ('{0:N0} MiB' -f ($bytes / 1MB))
}
function Format-Span([double]$sec) {
    if ($sec -lt 60) { return ('{0:N0} s' -f $sec) }
    $t = [TimeSpan]::FromSeconds([Math]::Round($sec))
    if ($t.TotalHours -ge 1) { return ('{0}h {1:00}m' -f [Math]::Floor($t.TotalHours), $t.Minutes) }
    return ('{0}m' -f $t.Minutes)
}
# "1.234 GiB" / "512 KiB" / "0 B" -> bytes
function Parse-Size([string]$s) {
    if ($s -notmatch '^\s*([\d.]+)\s*([KMGTPE]?)i?B') { return $null }
    $n = [double]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture)
    $p = @{ '' = 0; 'K' = 1; 'M' = 2; 'G' = 3; 'T' = 4; 'P' = 5; 'E' = 6 }[$Matches[2]]
    return $n * [Math]::Pow(1024, $p)
}

$script:Proc = $null
$script:LogFile = $null
$script:LogPos = 0
$script:WaitUntil = $null
$script:WaitReason = ''
$script:Samples = New-Object System.Collections.ArrayList     # (time, bytes done) for the steadier ETA
$script:Live = @{}                                           # latest figures, also sent to the logbook
$script:LastTick = $null
$script:LastSave = Get-Date
$script:LastReport = [datetime]::MinValue
$script:CheckOk = $false

function Start-Rclone([string[]]$ArgList, [bool]$captureOut) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $script:LogFile = Join-Path $LogDir ("$stamp-" + $ArgList[0] + '.log')
    $script:LogPos = 0
    $script:Samples.Clear()
    $script:Live = @{}
    $all = @($ArgList) + @('--config', $Conf, '--log-file', $script:LogFile, '--log-level', 'NOTICE',
        '--stats', '2s', '--stats-one-line', '--stats-log-level', 'NOTICE')
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Rclone
    $psi.Arguments = (($all | ForEach-Object { Quote-Arg $_ }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $captureOut
    $script:Proc = [System.Diagnostics.Process]::Start($psi)
}

function Read-NewLog {
    if (-not $script:LogFile -or -not (Test-Path -LiteralPath $script:LogFile)) { return '' }
    try {
        $fs = New-Object System.IO.FileStream($script:LogFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            if ($fs.Length -lt $script:LogPos) { $script:LogPos = 0 }
            [void]$fs.Seek($script:LogPos, [System.IO.SeekOrigin]::Begin)
            $sr = New-Object System.IO.StreamReader($fs)
            $text = $sr.ReadToEnd()
            $script:LogPos = $fs.Length
            return $text
        } finally { $fs.Dispose() }
    } catch { return '' }
}
function Read-WholeLog {
    if (-not $script:LogFile -or -not (Test-Path -LiteralPath $script:LogFile)) { return '' }
    try {
        $fs = New-Object System.IO.FileStream($script:LogFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try { return (New-Object System.IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
    } catch { return '' }
}

$StatsRegex = '(?<done>[\d.]+ ?[KMGTPE]?i?B) / (?<total>[\d.]+ ?[KMGTPE]?i?B), (?<pct>\d+|-)%?, (?<speed>[\d.]+ ?[KMGTPE]?i?B/s), ETA (?<eta>\S+)'

# ---------- Reports to the logbook (sent in the background, never holds up the window) ----------
function Send-Report([string]$note = '') {
    $s = $script:State
    if (-not $s['JobKey']) { return }
    $status = $s.Status
    if ($status -eq 'running' -and $script:WaitUntil) { $status = 'waiting' }
    $body = @{
        job = $s.JobKey; task = $s.Task; status = $status; phase = $s.Phase; source = $s.Source; started = $s.Started
        pct = $script:Live['pct']; doneBytes = $script:Live['done']; totalBytes = $script:Live['total']
        speed = $script:Live['speed']; etaSec = $script:Live['eta']
        files = $s['FileCount']; bytes = $s['ByteCount']; elapsedSec = [int]$s['ElapsedSec']; reconnects = [int]$s['Reconnects']
        checkOk = $script:CheckOk; note = $note
    } | ConvertTo-Json -Compress
    try {
        $wc = New-Object System.Net.WebClient
        $wc.Headers.Add('X-Logbook-Key', $script:Key)
        $wc.Headers.Add('Content-Type', 'application/json')
        $wc.UploadStringAsync([uri]($script:Site + '/logbook/api/pc/uploader/report'), 'POST', $body)
        $script:LastReport = Get-Date
    } catch { }
}

# ---------- Window ----------
$font     = New-Object System.Drawing.Font('Segoe UI', 10)
$fontBold = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$fontBig  = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Aspex Uploader - Aspex Drone Services'
$form.Size = New-Object System.Drawing.Size(860, 790)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.Font = $font

function New-Label($text, $x, $y, $w, $h) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text; $l.Location = New-Object System.Drawing.Point($x, $y); $l.Size = New-Object System.Drawing.Size($w, $h)
    $l.Font = $font
    return $l
}
function New-Box($x, $y, $w) {
    $t = New-Object System.Windows.Forms.TextBox
    $t.Location = New-Object System.Drawing.Point($x, $y); $t.Size = New-Object System.Drawing.Size($w, 26)
    $t.Font = $font
    return $t
}
function New-Button($text, $x, $y, $w, $h) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x, $y); $b.Size = New-Object System.Drawing.Size($w, $h)
    $b.Font = $font
    return $b
}
function New-Group($text, $x, $y, $w, $h) {
    $g = New-Object System.Windows.Forms.GroupBox
    $g.Text = $text; $g.Font = $fontBold
    $g.Location = New-Object System.Drawing.Point($x, $y); $g.Size = New-Object System.Drawing.Size($w, $h)
    return $g
}

# Pilot and job
$gJob = New-Group 'Pilot and job' 15 10 815 95
$gJob.Controls.Add((New-Label 'Pilot' 15 30 50 22))
$tPilot = New-Box 65 27 200; $tPilot.ReadOnly = $true
$gJob.Controls.Add($tPilot)
$gJob.Controls.Add((New-Label 'Job' 280 30 40 22))
$cJob = New-Object System.Windows.Forms.ComboBox
$cJob.DropDownStyle = 'DropDownList'; $cJob.Font = $font
$cJob.Location = New-Object System.Drawing.Point(320, 27); $cJob.Size = New-Object System.Drawing.Size(300, 26)
$gJob.Controls.Add($cJob)
$lJobHint = New-Label 'Your jobs come from your Aspex logbook.' 15 62 600 22
$gJob.Controls.Add($lJobHint)
$logoPath = Join-Path $AppDir 'logo.png'
if (Test-Path -LiteralPath $logoPath) {
    try {
        $pic = New-Object System.Windows.Forms.PictureBox
        $pic.Image = [System.Drawing.Image]::FromFile($logoPath)
        $pic.SizeMode = 'Zoom'
        $pic.Location = New-Object System.Drawing.Point(630, 14)
        $pic.Size = New-Object System.Drawing.Size(175, 74)
        $gJob.Controls.Add($pic)
    } catch { }
}
$form.Controls.Add($gJob)

# Section 1: back up
$g1 = New-Group '1. Back up an SD card to your SSD' 15 115 815 175
$g1.Controls.Add((New-Label 'SD card' 15 32 120 22))
$cCard = New-Object System.Windows.Forms.ComboBox
$cCard.DropDownStyle = 'DropDownList'; $cCard.Font = $font
$cCard.Location = New-Object System.Drawing.Point(140, 29); $cCard.Size = New-Object System.Drawing.Size(450, 26)
$g1.Controls.Add($cCard)
$bRefresh = New-Button 'Refresh' 600 27 90 30; $g1.Controls.Add($bRefresh)
$g1.Controls.Add((New-Label 'SSD' 15 70 120 22))
$tSsd = New-Box 140 67 450; $tSsd.ReadOnly = $true
$g1.Controls.Add($tSsd)
$bSsd = New-Button 'Choose...' 600 65 90 30; $g1.Controls.Add($bSsd)
$lBackupTo = New-Label 'Backs up to: (choose your SSD and the job)' 15 105 780 22
$g1.Controls.Add($lBackupTo)
$bBackup = New-Button 'Back up card' 15 132 200 34; $bBackup.Font = $fontBold
$g1.Controls.Add($bBackup)
$bCoverage = New-Button 'Check photo coverage' 230 132 220 34
$g1.Controls.Add($bCoverage)
$form.Controls.Add($g1)

# Section 2: upload
$g2 = New-Group '2. Upload to Aspex' 15 300 815 175
$rSsd = New-Object System.Windows.Forms.RadioButton
$rSsd.Text = 'From the SSD job folder (recommended)'; $rSsd.Font = $font; $rSsd.Checked = $true
$rSsd.Location = New-Object System.Drawing.Point(15, 30); $rSsd.Size = New-Object System.Drawing.Size(340, 24)
$g2.Controls.Add($rSsd)
$rCard = New-Object System.Windows.Forms.RadioButton
$rCard.Text = 'From the SD card chosen above'; $rCard.Font = $font
$rCard.Location = New-Object System.Drawing.Point(370, 30); $rCard.Size = New-Object System.Drawing.Size(300, 24)
$g2.Controls.Add($rCard)
$g2.Controls.Add((New-Label 'Files at once' 15 67 120 22))
$cTransfers = New-Object System.Windows.Forms.ComboBox
$cTransfers.DropDownStyle = 'DropDownList'; $cTransfers.Font = $font
$cTransfers.Location = New-Object System.Drawing.Point(140, 64); $cTransfers.Size = New-Object System.Drawing.Size(80, 26)
[void]$cTransfers.Items.AddRange(@('16', '32', '48', '64'))
$g2.Controls.Add($cTransfers)
$g2.Controls.Add((New-Label '16: under 10 Mbps upload   32: Starlink / 10-40 Mbps   48: 40-100 Mbps   64: over 100 Mbps' 230 67 570 22))
$lUploadTo = New-Label 'Uploads to: Aspex' 15 105 780 22
$g2.Controls.Add($lUploadTo)
$bUpload = New-Button 'Start upload' 15 132 200 34; $bUpload.Font = $fontBold
$g2.Controls.Add($bUpload)
$form.Controls.Add($g2)

# Progress
$gP = New-Group 'Progress' 15 485 815 150
$lStatus = New-Label 'Ready.' 15 28 785 26; $lStatus.Font = $fontBig
$gP.Controls.Add($lStatus)
$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Location = New-Object System.Drawing.Point(15, 58); $bar.Size = New-Object System.Drawing.Size(660, 24)
$bar.Minimum = 0; $bar.Maximum = 100
$gP.Controls.Add($bar)
$bStop = New-Button 'Stop' 690 55 110 30; $bStop.Enabled = $false
$gP.Controls.Add($bStop)
$lDetail = New-Label '' 15 90 785 24
$gP.Controls.Add($lDetail)
$lExtra = New-Label '' 15 116 785 24
$gP.Controls.Add($lExtra)
$form.Controls.Add($gP)

# Messages for Kimberly
$gM = New-Group 'Message for Kimberly' 15 645 815 85
$gM.Controls.Add((New-Label 'Blocks flown today' 15 33 140 22))
$tBlocks = New-Box 160 30 150
$gM.Controls.Add($tBlocks)
$bMsgDay = New-Button "Copy today's message" 325 28 220 32; $bMsgDay.Enabled = $false
$gM.Controls.Add($bMsgDay)
$bMsgDone = New-Button 'Copy JOB COMPLETE message' 555 28 245 32; $bMsgDone.Enabled = $false
$gM.Controls.Add($bMsgDone)
$form.Controls.Add($gM)

# ---------- Jobs from the logbook ----------
$script:Jobs = @()
function Load-Jobs {
    $list = $null; $name = ''
    try {
        $r = Invoke-Logbook '/logbook/api/pc/uploader/jobs' 15
        $list = @($r.jobs); $name = [string]$r.name
        $script:Settings['JobsCache'] = $list; $script:Settings['PilotName'] = $name
        Write-JsonFile $SettingsFile $script:Settings
        $lJobHint.Text = 'Your jobs come from your Aspex logbook.'
    } catch {
        $list = @($script:Settings['JobsCache']); $name = [string]$script:Settings['PilotName']
        $lJobHint.Text = 'No connection to the logbook right now - showing your saved job list.'
    }
    $script:Jobs = @($list | Where-Object { $_ -and $_.key })
    $tPilot.Text = $name
    $cJob.Items.Clear()
    foreach ($j in $script:Jobs) {
        $label = $j.name
        if ($j.start) { $label += "  ($($j.start))" }
        [void]$cJob.Items.Add($label)
    }
    if ($script:Jobs.Count -eq 0) { $lJobHint.Text = 'No jobs yet. Jobs Aspex assigns to you in the logbook appear here.' }
}
function Select-Job([string]$key) {
    for ($i = 0; $i -lt $script:Jobs.Count; $i++) { if ($script:Jobs[$i].key -eq $key) { $cJob.SelectedIndex = $i; return } }
}
function Get-SelectedJob {
    if ($cJob.SelectedIndex -ge 0 -and $cJob.SelectedIndex -lt $script:Jobs.Count) { return $script:Jobs[$cJob.SelectedIndex] }
    return $null
}

# ---------- UI logic ----------
function Get-Pilot { return (Clean-Name $tPilot.Text) }
function Get-Job { $j = Get-SelectedJob; if ($j) { return (Clean-Name ([string]$j.folder)) }; return '' }
function Get-SsdJobFolder {
    $root = $tSsd.Text; $job = Get-Job
    if (-not $root -or -not $job) { return '' }
    if ((Split-Path -Leaf $root) -eq $job) { return $root }
    return (Join-Path $root $job)
}
function Get-CardDrive {
    if ($cCard.SelectedItem) { return ([string]$cCard.SelectedItem).Substring(0, 2) }
    return ''
}
function Update-Labels {
    $f = Get-SsdJobFolder
    if ($f) { $lBackupTo.Text = "Backs up to: $f" } else { $lBackupTo.Text = 'Backs up to: (choose your SSD and the job)' }
    $p = Get-Pilot; $j = Get-Job
    if ($p -and $j) { $lUploadTo.Text = "Uploads to: Aspex > Uploads/$j/$p" } else { $lUploadTo.Text = 'Uploads to: Aspex (choose the job)' }
}
function Fill-Cards {
    $cCard.Items.Clear()
    try {
        $disks = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2'
        foreach ($d in $disks) { [void]$cCard.Items.Add(('{0}  {1}' -f $d.DeviceID, $d.VolumeName)) }
    } catch { }
    if ($cCard.Items.Count -gt 0) { $cCard.SelectedIndex = 0 }
}
function Set-Busy([bool]$busy) {
    $bBackup.Enabled = -not $busy; $bUpload.Enabled = -not $busy; $bStop.Enabled = $busy
    $cJob.Enabled = -not $busy; $bSsd.Enabled = -not $busy
    $cCard.Enabled = -not $busy; $bRefresh.Enabled = -not $busy; $cTransfers.Enabled = -not $busy
    $rSsd.Enabled = -not $busy; $rCard.Enabled = -not $busy
}
function Save-Settings {
    $j = Get-SelectedJob
    if ($j) { $script:Settings['JobKey'] = $j.key }
    $script:Settings['Ssd'] = $tSsd.Text
    $script:Settings['Transfers'] = [string]$cTransfers.SelectedItem
    Write-JsonFile $SettingsFile $script:Settings
}
function Show-Extra {
    $s = $script:State
    $t = 'Running ' + (Format-Span ([double]$s['ElapsedSec']))
    $r = [int]$s['Reconnects']
    if ($r -eq 1) { $t += '  |  reconnected once' } elseif ($r -gt 1) { $t += "  |  reconnected $r times" }
    $lExtra.Text = $t
}

# ---------- Task engine ----------
function Start-Task([string]$task, [string]$source, [string]$dest) {
    Save-Settings
    $j = Get-SelectedJob
    $script:State = @{
        Task = $task; Source = $source; Dest = $dest; Phase = 'copy'; Status = 'running'
        Transfers = [string]$cTransfers.SelectedItem; Pilot = (Get-Pilot); Job = (Get-Job); JobKey = $j.key
        Started = (Get-Date).ToString('s'); FileCount = $null; ByteCount = $null; ElapsedSec = 0; Reconnects = 0
    }
    $script:CheckOk = $false
    Save-State
    $bMsgDay.Enabled = $false; $bMsgDone.Enabled = $false
    Set-Busy $true
    Set-Awake $true
    $script:LastTick = Get-Date
    Start-Phase
}

function Wait-Then([int]$seconds, [string]$reason) {
    $script:Proc = $null
    $script:WaitUntil = (Get-Date).AddSeconds($seconds)
    $script:WaitReason = $reason
    if ($reason -eq 'retry') { $script:State.Reconnects = [int]$script:State['Reconnects'] + 1; Save-State; Show-Extra }
    Send-Report $lStatus.Text
}

function Start-Phase {
    $s = $script:State
    $what = 'Upload'; if ($s.Task -eq 'backup') { $what = 'Backup' }
    if (-not (Test-Path -LiteralPath $s.Source)) {
        $lStatus.Text = "Waiting for $($s.Source) - plug in the card or SSD."
        Wait-Then 10 'drive'
        return
    }
    if ($s.Task -eq 'backup') {
        $qual = Split-Path -Qualifier $s.Dest
        if (-not (Test-Path -LiteralPath ($qual + '\'))) {
            $lStatus.Text = "Waiting for the SSD ($qual) - plug it in."
            Wait-Then 10 'drive'
            return
        }
    }
    $bar.Style = 'Blocks'; $bar.Value = 0; $lDetail.Text = ''
    switch ($s.Phase) {
        'copy' {
            if ($s.Task -eq 'backup') {
                $lStatus.Text = 'Backing up the card to the SSD...'
                Start-Rclone @('copy', $s.Source, $s.Dest, '--retries', '3') $false
            } else {
                $lStatus.Text = 'Uploading to Aspex...'
                Start-Rclone @('copy', $s.Source, $s.Dest, '--size-only', '--transfers', $s.Transfers, '--checkers', '16',
                    '--retries', '20', '--low-level-retries', '50') $false
            }
        }
        'check' {
            $lStatus.Text = "$what finished. Checking every file arrived..."
            $lDetail.Text = 'Comparing every file name and size. On a big job this can take a few minutes; the bar moves while it works.'
            $bar.Style = 'Marquee'
            # The copy already checked every file's MD5 as it went, so this only confirms every file is there
            # at the right size - seconds, instead of reading the whole card and SSD again.
            Start-Rclone @('check', $s.Source, $s.Dest, '--size-only', '--one-way') $false
        }
        'size' {
            $lStatus.Text = 'Checked. Adding up the totals...'
            $bar.Style = 'Marquee'
            Start-Rclone @('size', $s.Dest, '--json') $true
        }
    }
    Send-Report $lStatus.Text
}

function Finish-Task {
    $s = $script:State
    $s.Status = 'done'; Save-State
    $script:Proc = $null
    Set-Awake $false
    Set-Busy $false
    $bar.Style = 'Blocks'; $bar.Value = 100
    $script:Live = @{ pct = 100 }
    if ($s.Task -eq 'backup') {
        $lStatus.Text = 'Backup complete - 0 differences found.'
        $lDetail.Text = "The card is safely copied to $($s.Dest). Keep the card until Aspex confirms the data has been analysed."
    } else {
        $lStatus.Text = 'Upload complete - 0 differences found.'
        if ($s.FileCount -ne $null) { $lDetail.Text = ('Total uploaded for this job: {0:N0} files, {1}. Aspex can see this on the job page.' -f [double]$s.FileCount, (Format-Size ([double]$s.ByteCount))) }
        $bMsgDay.Enabled = $true; $bMsgDone.Enabled = $true
    }
    Show-Extra
    Send-Report $lStatus.Text
    [System.Media.SystemSounds]::Asterisk.Play()
}

function Stop-Task([string]$why) {
    if ($script:Proc -and -not $script:Proc.HasExited) { try { $script:Proc.Kill() } catch { } }
    $script:Proc = $null
    $script:WaitUntil = $null
    if ($script:State['Status'] -eq 'running') { $script:State.Status = 'stopped'; Save-State; Send-Report $why }
    Set-Awake $false
    Set-Busy $false
    $bar.Style = 'Blocks'
    $lStatus.Text = $why
    $lDetail.Text = 'Press the same button again to carry on where it stopped.'
}

function On-Exit {
    $s = $script:State
    $code = $script:Proc.ExitCode
    $out = ''
    if ($s.Phase -eq 'size') { try { $out = $script:Proc.StandardOutput.ReadToEnd() } catch { } }
    $log = Read-WholeLog
    $script:Proc = $null
    $bar.Style = 'Blocks'
    switch ($s.Phase) {
        'copy' {
            if ($code -eq 0) { $s.Phase = 'check'; Save-State; Start-Phase }
            else {
                $lStatus.Text = 'Connection or drive lost. Retrying in 30 seconds - nothing is lost.'
                Wait-Then 30 'retry'
            }
        }
        'check' {
            if ($code -eq 0 -and $log -match '\b0 differences found') {
                $script:CheckOk = $true
                if ($s.Task -eq 'upload') { $s.Phase = 'size'; Save-State; Start-Phase }
                else { Finish-Task }
            } else {
                $s.Phase = 'copy'; Save-State
                if ($log -match '(\d+) differences found') {
                    $lStatus.Text = "Check found $($Matches[1]) files still to send. Sending them now..."
                    Wait-Then 3 'check'
                } else {
                    $lStatus.Text = 'Check could not finish (connection?). Retrying in 30 seconds.'
                    Wait-Then 30 'retry'
                }
            }
        }
        'size' {
            try { $j = $out | ConvertFrom-Json; $s.FileCount = $j.count; $s.ByteCount = $j.bytes } catch { }
            Finish-Task
        }
    }
}

# Steadier ETA: average speed over the last 15 minutes of this run, not rclone's moment-to-moment figure.
function Update-Progress($m) {
    $now = Get-Date
    $done = Parse-Size $m.Groups['done'].Value
    $total = Parse-Size $m.Groups['total'].Value
    $pct = $m.Groups['pct'].Value
    if ($pct -match '^\d+$' -and $bar.Style -ne 'Marquee') { $bar.Value = [Math]::Min(100, [int]$pct) }
    if ($done -ne $null) {
        [void]$script:Samples.Add(@{ t = $now; b = $done })
        while ($script:Samples.Count -gt 1 -and ($now - $script:Samples[0].t).TotalMinutes -gt 15) { $script:Samples.RemoveAt(0) }
    }
    $speed = $null; $eta = $null
    if ($script:Samples.Count -ge 2) {
        $first = $script:Samples[0]; $last = $script:Samples[$script:Samples.Count - 1]
        $span = ($last.t - $first.t).TotalSeconds
        if ($span -ge 60) {
            $speed = ($last.b - $first.b) / $span
            if ($speed -gt 0 -and $total -ne $null -and $done -ne $null) { $eta = ($total - $done) / $speed }
        }
    }
    $speedText = $m.Groups['speed'].Value
    $etaText = $m.Groups['eta'].Value
    if ($speed -ne $null) {
        if ($speed -ge 1MB) { $speedText = ('{0:N1} MiB/s' -f ($speed / 1MB)) } else { $speedText = ('{0:N0} KiB/s' -f ($speed / 1KB)) }
        $speedText += ' (15-min average)'
        if ($eta -ne $null) { $etaText = 'about ' + (Format-Span $eta) + ' left' } else { $etaText = 'working it out' }
    } elseif ($etaText -eq '-') { $etaText = 'working it out' } else { $etaText = "about $etaText left" }
    $lDetail.Text = "$($m.Groups['done'].Value) of $($m.Groups['total'].Value)  |  $speedText  |  $etaText"
    $p = $null; if ($pct -match '^\d+$') { $p = [int]$pct }
    $script:Live = @{ pct = $p; done = $done; total = $total; speed = $speed; eta = $eta }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
    if ($script:State['Status'] -ne 'running') { return }
    $now = Get-Date
    if ($script:LastTick) { $script:State.ElapsedSec = [double]$script:State['ElapsedSec'] + ($now - $script:LastTick).TotalSeconds }
    $script:LastTick = $now
    Show-Extra
    if (($now - $script:LastSave).TotalSeconds -ge 15) { Save-State; $script:LastSave = $now }
    if (($now - $script:LastReport).TotalSeconds -ge 60) { Send-Report $lStatus.Text }
    if ($script:WaitUntil) {
        $left = [int]($script:WaitUntil - $now).TotalSeconds
        if ($left -gt 0) {
            if ($script:WaitReason -eq 'retry') { $lDetail.Text = "Trying again in $left s..." }
            return
        }
        $script:WaitUntil = $null
        Start-Phase
        return
    }
    if (-not $script:Proc) { return }
    $text = Read-NewLog
    if ($text) {
        if ($script:State['Phase'] -eq 'copy') {
            $ms = [regex]::Matches($text, $StatsRegex)
            if ($ms.Count -gt 0) { Update-Progress $ms[$ms.Count - 1] }
        }
    }
    if ($script:Proc.HasExited) { On-Exit }
})

# ---------- Buttons ----------
$cJob.Add_SelectedIndexChanged({ Update-Labels })
$bRefresh.Add_Click({ Fill-Cards })
$bSsd.Add_Click({
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = 'Choose your SSD (or the job folder on it)'
    if ($dlg.ShowDialog() -eq 'OK') { $tSsd.Text = $dlg.SelectedPath; Update-Labels }
})

$bBackup.Add_Click({
    if (-not (Get-Job)) { [System.Windows.Forms.MessageBox]::Show('Choose the job first.', 'Aspex Uploader') | Out-Null; return }
    $drive = Get-CardDrive
    if (-not $drive) { [System.Windows.Forms.MessageBox]::Show('Insert the SD card, then press Refresh and choose it.', 'Aspex Uploader') | Out-Null; return }
    $src = "$drive\DCIM"
    if (-not (Test-Path -LiteralPath $src)) { [System.Windows.Forms.MessageBox]::Show("There's no DCIM folder on $drive. Is this the drone's SD card?", 'Aspex Uploader') | Out-Null; return }
    $dest = Get-SsdJobFolder
    if (-not $dest) { [System.Windows.Forms.MessageBox]::Show('Choose your SSD first.', 'Aspex Uploader') | Out-Null; return }
    Start-Task 'backup' $src $dest
})

$bCoverage.Add_Click({
    $j = Get-SelectedJob
    if (-not $j) { [System.Windows.Forms.MessageBox]::Show('Choose the job first.', 'Aspex Uploader') | Out-Null; return }
    $url = $script:Site + '/logbook/#coverage=' + [uri]::EscapeDataString([string]$j.key) + '&t=' + [uri]::EscapeDataString([string]$j.name)
    Start-Process $url
})

$bUpload.Add_Click({
    $p = Get-Pilot; $j = Get-Job
    if (-not $p -or -not $j) { [System.Windows.Forms.MessageBox]::Show('Choose the job first.', 'Aspex Uploader') | Out-Null; return }
    if ($rCard.Checked) {
        $drive = Get-CardDrive
        if (-not $drive) { [System.Windows.Forms.MessageBox]::Show('Insert the SD card, then press Refresh and choose it.', 'Aspex Uploader') | Out-Null; return }
        $src = "$drive\DCIM"
    } else {
        $src = Get-SsdJobFolder
        if (-not $src) { [System.Windows.Forms.MessageBox]::Show('Choose your SSD first (section 1).', 'Aspex Uploader') | Out-Null; return }
    }
    if (-not (Test-Path -LiteralPath $src)) { [System.Windows.Forms.MessageBox]::Show("Can't find $src.", 'Aspex Uploader') | Out-Null; return }
    $dest = "aspex:Uploads/$j/$p"
    $ok = [System.Windows.Forms.MessageBox]::Show("Upload everything in`n$src`n`nto Aspex > Uploads/$j/$p ?`n`nFiles already uploaded are skipped.", 'Aspex Uploader', 'YesNo')
    if ($ok -ne 'Yes') { return }
    Start-Task 'upload' $src $dest
})

$bStop.Add_Click({ Stop-Task 'Stopped.' })

$bMsgDay.Add_Click({
    $s = $script:State
    $blocks = $tBlocks.Text; if (-not $blocks) { $blocks = '___' }
    $msg = ('{0} - {1} uploaded. Blocks flown today: {2}. Check: 0 differences. Total so far: {3:N0} files, {4}.' -f $s.Job, (Get-Date -Format 'd MMM'), $blocks, [double]$s.FileCount, (Format-Size ([double]$s.ByteCount)))
    [System.Windows.Forms.Clipboard]::SetText($msg)
    [System.Windows.Forms.MessageBox]::Show("Copied. Paste it into your message to Kimberly:`n`n$msg", 'Aspex Uploader') | Out-Null
})
$bMsgDone.Add_Click({
    $s = $script:State
    $ok = [System.Windows.Forms.MessageBox]::Show('Only use this when every card for the job is uploaded. Is the job complete?', 'Aspex Uploader', 'YesNo')
    if ($ok -ne 'Yes') { return }
    $msg = ('{0} COMPLETE. Flying dates: ___. Blocks flown: ___. Final check: 0 differences. Total: {1:N0} files, {2}.' -f $s.Job, [double]$s.FileCount, (Format-Size ([double]$s.ByteCount)))
    [System.Windows.Forms.Clipboard]::SetText($msg)
    [System.Windows.Forms.MessageBox]::Show("Copied. Fill in the blanks, then send it to Kimberly:`n`n$msg", 'Aspex Uploader') | Out-Null
})

$form.Add_FormClosing({
    param($sender, $e)
    if ($e.CloseReason -eq [System.Windows.Forms.CloseReason]::WindowsShutDown) {
        # Windows is shutting down or restarting: stop rclone but keep the job marked as running,
        # so it carries on by itself at the next sign-in.
        if ($script:Proc -and -not $script:Proc.HasExited) { try { $script:Proc.Kill() } catch { } }
        Save-State
        $timer.Stop()
        return
    }
    if ($script:State['Status'] -eq 'running') {
        $ok = [System.Windows.Forms.MessageBox]::Show("Stop and close?`n`nNothing is lost: open Aspex Uploader later and press the same button to carry on where it stopped.", 'Aspex Uploader', 'YesNo')
        if ($ok -ne 'Yes') { $e.Cancel = $true; return }
        Stop-Task 'Stopped.'
    }
    $timer.Stop()
    Set-Awake $false
})

# ---------- Start ----------
Fill-Cards
Load-Jobs
if ($script:Settings['JobKey']) { Select-Job ([string]$script:Settings['JobKey']) }
if ($script:Settings['Ssd'])   { $tSsd.Text = $script:Settings['Ssd'] }
$tr = $script:Settings['Transfers']; if (-not $tr) { $tr = '32' }
$cTransfers.SelectedItem = [string]$tr
Update-Labels

$form.Add_Shown({
    $timer.Start()
    if ($script:State['Status'] -eq 'running') {
        if ($script:State['JobKey']) { Select-Job ([string]$script:State.JobKey) }
        if ($script:State.Transfers) { $cTransfers.SelectedItem = [string]$script:State.Transfers }
        Set-Busy $true
        Set-Awake $true
        $script:LastTick = Get-Date
        $lStatus.Text = 'Carrying on where it left off...'
        Show-Extra
        Start-Phase
    } elseif ($script:State['Status'] -eq 'done' -and $script:State['Task'] -eq 'upload' -and $script:State['FileCount'] -ne $null) {
        $bMsgDay.Enabled = $true; $bMsgDone.Enabled = $true
        $lStatus.Text = 'Last upload complete - 0 differences found.'
    }
})

[System.Windows.Forms.Application]::Run($form)
try { $script:Mutex.ReleaseMutex() } catch { }
