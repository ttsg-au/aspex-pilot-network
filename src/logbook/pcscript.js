// Builds "Import Flights.cmd" for the drone PC, with this site's address and upload key built in.
// Double-clicking it: copies new flight records off the DJI controller (USB) into the Dropbox
// archive folder, sends any the website hasn't got yet, opens the logbook, then closes itself.
// The file is a .cmd that runs the PowerShell below it, so there's nothing to install.

function importCmd(baseUrl, key) {
  const ps = String.raw`
$ErrorActionPreference = 'Stop'
$Site = '__SITE__'
$Key  = '__KEY__'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Host.UI.RawUI.WindowTitle = 'Aspex Logbook - importing flights'
function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Finish($code) { Say ''; Say 'This window closes by itself in 15 seconds.' DarkGray; Start-Sleep 15; exit $code }

# ---- where the original files are archived: Dropbox (synced to the cloud) ----
$archive = $null
$info = Join-Path $env:LOCALAPPDATA 'Dropbox\info.json'
if (Test-Path -LiteralPath $info) {
  $dbx = Get-Content -LiteralPath $info -Raw | ConvertFrom-Json
  $roots = @($dbx.business.path, $dbx.personal.path) | Where-Object { $_ }
  $root = ($roots | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'Aspex Drone Services') } | Select-Object -First 1)
  if (-not $root) { $root = $roots | Select-Object -First 1 }
  if ($root) { $archive = Join-Path $root 'Aspex Drone Services\Flight Records' }
}
if (-not $archive) { $archive = Join-Path $env:USERPROFILE 'Documents\FlightLogs\incoming'; Say 'Dropbox not found on this PC - keeping the original files in Documents\FlightLogs\incoming.' Yellow }
New-Item -ItemType Directory -Force -Path $archive | Out-Null
Say "Original flight records are kept in: $archive"

# One-off: bring across records already copied to this PC by the old logbook.
$old = Join-Path $env:USERPROFILE 'Documents\FlightLogs\incoming'
if ((Test-Path -LiteralPath $old) -and ($old -ne $archive)) {
  $n = 0
  Get-ChildItem -LiteralPath $old -File | Where-Object { $_.Name -match '^(DJI)?FlightRecord_' } | ForEach-Object {
    $t = Join-Path $archive $_.Name
    if (-not (Test-Path -LiteralPath $t)) { Copy-Item -LiteralPath $_.FullName -Destination $t; $n++ }
  }
  if ($n) { Say "Moved $n older records into the archive (one-off)." }
}

# ---- 1. copy new records off the controller ----
$targets = @('DJI\com.dji.industry.pilot\FlightRecord', 'Android\data\dji.go.v5\files\FlightRecord', 'DJI\dji.go.v5\FlightRecord', 'DJI\dji.go.v4\FlightRecord')
$shell = New-Object -ComObject Shell.Application
$destFolder = $shell.NameSpace($archive)
$devices = @($shell.NameSpace(17).Items() | Where-Object { -not $_.IsFileSystem })
function Open-Path($folder, $rel) {
  foreach ($part in $rel.Split('\')) {
    $next = $null
    foreach ($i in $folder.Items()) { if ($i.IsFolder -and $i.Name -eq $part) { $next = $i.GetFolder; break } }
    if (-not $next) { return $null }
    $folder = $next
  }
  return $folder
}
$have = @{}
Get-ChildItem -LiteralPath $archive -File | ForEach-Object { $have[$_.BaseName] = $true; $have[$_.Name] = $true }
$found = 0; $copied = 0
if ($devices.Count -eq 0) {
  Say ''
  Say 'No controller found. Plug the controller in by USB, switch the DRONE on as well and let it link, then run this again.' Yellow
  Say '(With most DJI controllers the flight files only appear on the PC while the drone is switched on.)' Yellow
  Say 'Carrying on with any records already in the archive that the website does not have yet.' Yellow
} else {
  Say ''; Say 'Step 1 of 2: copying from the controller' Cyan
  foreach ($dev in $devices) {
    foreach ($storage in $dev.GetFolder.Items()) {
      if (-not $storage.IsFolder) { continue }
      foreach ($t in $targets) {
        $f = Open-Path $storage.GetFolder $t
        if (-not $f) { continue }
        # Windows lists big folders on a USB device gradually - wait until the count stops growing.
        $last = -1; $stable = 0; $deadline = (Get-Date).AddMinutes(3)
        while ($stable -lt 4 -and (Get-Date) -lt $deadline) {
          $n = $f.Items().Count
          if ($n -eq $last) { $stable++ } else { $stable = 0; $last = $n; Say "  reading the controller... $n files" }
          Start-Sleep -Milliseconds 1500
        }
        foreach ($item in $f.Items()) {
          if ($item.IsFolder -or $item.Name -notmatch '^(DJI)?FlightRecord_') { continue }
          $found++
          $name = $item.Name
          if ($have.ContainsKey($name) -or $have.ContainsKey(($name -replace '\.txt$', ''))) { continue }
          $destFolder.CopyHere($item, 4 + 16 + 1024)
          $timeout = (Get-Date).AddMinutes(2)
          do {
            Start-Sleep -Milliseconds 250
            $c = Get-ChildItem -LiteralPath $archive -File -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -eq ($name -replace '\.txt$', '') } | Select-Object -First 1
          } until (($c -and $c.Length -gt 0) -or (Get-Date) -gt $timeout)
          if ($c) { $copied++; $have[$name] = $true; Say "  copied  $name" } else { Say "  FAILED  $name" Red }
        }
      }
    }
  }
  Say "  $found records on the controller, $copied new."
  if ($found -eq 0) {
    Say ''
    Say 'The controller is connected but no flight records were found.' Yellow
    Say 'Switch the DRONE on and let it link to the controller - with most DJI controllers the flight files' Yellow
    Say 'only appear on the PC while the drone is on. Then run Import Flights again.' Yellow
  }
}

# ---- 2. send the ones the website hasn't got ----
Say ''; Say 'Step 2 of 2: sending to the logbook website' Cyan
$files = @(Get-ChildItem -LiteralPath $archive -File | Where-Object { $_.Name -match '^(DJI)?FlightRecord_.*\.txt$' })
$list = @($files | ForEach-Object { @{ name = $_.Name; bytes = $_.Length } })
$headers = @{ 'X-Logbook-Key' = $Key }
try {
  $need = Invoke-RestMethod -Method Post -Uri "$Site/logbook/api/pc/need" -Headers $headers -ContentType 'application/json' -Body (ConvertTo-Json @{ files = $list } -Depth 4 -Compress)
} catch {
  Say "Could not reach the logbook website: $($_.Exception.Message)" Red
  Say 'Check the internet connection and try again. Nothing has been lost - the files are in the archive.' Yellow
  Finish 1
}
$todo = @($files | Where-Object { $need.need -contains $_.Name })
if ($todo.Count -eq 0) { Say '  The website already has every flight.' }
$i = 0; $ok = 0; $bad = 0
foreach ($f in $todo) {
  $i++
  try {
    $bytes = [IO.File]::ReadAllBytes($f.FullName)
    $r = Invoke-RestMethod -Method Post -Uri ("$Site/logbook/api/pc/upload?name=" + [uri]::EscapeDataString($f.Name)) -Headers $headers -ContentType 'application/octet-stream' -Body $bytes -TimeoutSec 300
    $ok++
    Say ("  [{0}/{1}] {2}  {3}" -f $i, $todo.Count, $f.Name, $r.summary)
  } catch {
    $bad++
    Say ("  [{0}/{1}] {2}  FAILED: {3}" -f $i, $todo.Count, $f.Name, $_.Exception.Message) Red
  }
}
try { Invoke-RestMethod -Method Post -Uri "$Site/logbook/api/pc/done" -Headers $headers -ContentType 'application/json' -Body (ConvertTo-Json @{ onController = $found; copied = $copied; sent = $ok; failed = $bad } -Compress) | Out-Null } catch {}
Say ''
Say "Done: $copied copied from the controller, $ok sent to the website$(if ($bad) { ", $bad failed (run again to retry)" })." Green
Start-Process "$Site/logbook/"
Finish 0
`.replace('__SITE__', baseUrl.replace(/'/g, "''")).replace('__KEY__', key);

  // .cmd wrapper: cmd runs the PowerShell that follows the #> line.
  return `<# :
@echo off
title Aspex Logbook - importing flights
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = Get-Content -LiteralPath '%~f0' -Raw; Invoke-Expression ($s.Substring($s.IndexOf('#'+'>') + 2))"
exit /b
#>
${ps.trim()}
`.replace(/\r?\n/g, '\r\n');
}

module.exports = { importCmd };
